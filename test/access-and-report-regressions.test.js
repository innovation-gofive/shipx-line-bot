const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store');
const {ShipXClient,COMPANY_ENDPOINT,SHIPPING_ENDPOINT,SHIPPING_HISTORY_ENDPOINT,reportDates}=require('../src/shipx');
const {answerCommand}=require('../src/bot');
const {parseCommand,interpret}=require('../src/intent');
const {createApp}=require('../src/app');
const {createNotifications}=require('../src/notifications');
const companyId=101,groupId='C'+'1'.repeat(32),actor='U'+'a'.repeat(32);
const config={origin:'http://localhost:3000',shipxBaseUrl:'https://api.example.test',adminUsername:'admin',adminPassword:'long-test-password',lineSecret:'test-secret',lineToken:'test-token',shippingDateIsDueDate:true};
function setup(t,visible=[]){
  const store=new Store(':memory:');store.seedDemo();t.after(()=>store.close());
  const f={store,visible,token:'first-access',revision:1,lastSuccess:Date.now(),directoryCalls:0,businessCalls:[]};
  f.tokens={oauth:{enabled:()=>true,ensure:async()=>f.token,background:async()=>{},cancel:()=>{},status:()=>({enabled:true,revision:f.revision,lastSuccess:f.lastSuccess,expiresAt:Date.now()+3600000,state:'ready',lastError:null})}};
  f.client=new ShipXClient(config,async(url,options)=>{
    if(url.pathname===COMPANY_ENDPOINT){f.directoryCalls++;return Response.json({data:{companies:f.visible.map(id=>({companyId:id,companyName:'Company '+id}))}});}
    f.businessCalls.push(url.pathname);
    if(url.pathname===SHIPPING_ENDPOINT)return Response.json({data:{totalCount:0,data:[]}});
    if(url.pathname==='/api/v2/Order/search')return Response.json({data:{data:[],hasMore:false,pageNumber:1,pageSize:100}});
    throw new Error('Unexpected business request '+url.pathname);
  },f.tokens);
  return f;
}
test('an issued automatic token without mapped-company visibility never produces a zero or not-found report',async t=>{
  const f=setup(t,[202]);
  for(const request of [()=>f.client.findOrder(companyId,'SO001'),()=>f.client.findStock(companyId,'SKU001'),()=>f.client.stockOverview(companyId),()=>f.client.orderOverview(companyId,1,new Date()),()=>f.client.shippingProgress(companyId),()=>f.client.dailyShippedOrders(companyId)]){
    await assert.rejects(request(),{reason:'company_access_not_verified',statusCode:403,retryable:false});
  }
  assert.equal(f.directoryCalls,1);assert.equal(f.businessCalls.length,0);
  const result=await answerCommand({store:f.store,shipx:f.client,groupId,actor,text:'วันนี้มีกี่ออเดอร์',escalate:true,requestId:'missing-company'});
  assert.match(result.text,/รอทางแอดมิน/);assert.doesNotMatch(result.text,/ออเดอร์ทั้งหมด: 0/);
  assert.equal(f.store.support.list().rows[0].reason,'company_access_not_verified');
  assert(f.store.audits().some(row=>row.detail==='HTTP 403 (company_access_not_verified)'));
});
test('a verified company may legitimately have zero orders and concurrent requests share one directory check',async t=>{
  const f=setup(t,[companyId]);
  const rows=await Promise.all(Array.from({length:8},()=>f.client.orderOverview(companyId,1,new Date('2026-11-27T15:00:00+07:00'))));
  assert(rows.every(days=>days[0].total===0));assert.equal(f.directoryCalls,1);assert.equal(f.businessCalls.length,8);
  assert.equal(f.client.accessStatus(f.store.groups()).missingCompanies.length,0);
});
test('a replacement token or an expired access cache cannot inherit the former token company visibility',async t=>{
  const f=setup(t,[companyId]);await f.client.findOrder(companyId,'SO001');
  f.token='replacement-access';f.lastSuccess++;f.visible=[];
  await assert.rejects(f.client.findOrder(companyId,'SO001'),{reason:'company_access_not_verified'});assert.equal(f.directoryCalls,2);
  f.visible=[companyId];f.client.companyAccess.until=0;await f.client.findOrder(companyId,'SO001');assert.equal(f.directoryCalls,3);
});
test('mapping credentials changed while verifying a directory cannot authorize a stale context',async t=>{
  const f=setup(t,[companyId]);f.client.fetcher=async()=>{f.revision++;return Response.json({data:{companies:[{companyId,companyName:'Own'}]}});};
  await assert.rejects(f.client.findOrder(companyId,'SO001'),{reason:'company_access_context_changed'});assert.equal(f.businessCalls.length,0);
});
test('scheduled notifications do not label inaccessible orders as no issues or send a zero card',async t=>{
  const f=setup(t,[]),group=f.store.group(groupId);
  f.store.mapGroup(groupId,{companyId,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:true,alertsEnabled:true,alertsTime:'15:00',revision:group.revision,name:'Own'},'admin');
  let sent=0;await createNotifications({config,store:f.store,shipx:f.client,tokens:f.tokens,line:{push:async()=>sent++},clock:()=>new Date('2026-11-27T15:00:00+07:00')}).tick();
  assert.equal(sent,0);assert.equal(f.store.db.prepare('SELECT state FROM notifications').get().state,'failed');
  assert(!f.store.audits().some(row=>row.action==='notification.shipping'&&row.outcome==='no_issues'));
});
test('yesterday shipping questions select actual outbound scans and retain the locally bound day',async()=>{
  const question='ขอรายงานการจัดส่ง ที่ส่งไปเมื่อวานหน่อย';
  assert.deepEqual(parseCommand(question),{type:'daily_shipped',days:1,offset:1});
  assert.deepEqual(await interpret(question,async()=> 'overview'),{type:'daily_shipped',days:1,offset:1});
  assert.deepEqual(parseCommand('รายงานการจัดส่งเมื่อวานซืน'),{type:'daily_shipped',days:1,offset:2});
  assert.equal(parseCommand('ออเดอร์กำหนดส่งวันนี้ที่ยังแพ็คไม่เสร็จ').type,'shipping_issues');
});
test('daily shipping history filters a wider response to the requested Bangkok day and yesterday end-of-day',async()=>{
  const calls=[],now=new Date('2026-11-27T15:30:00+07:00');
  const make=(id,date)=>({summaryPlatformBatchId:id,companyId,dateCreated:date,successCount:1,platform:'Shopee',items:[{orderId:id,previousStatus:2003,newStatus:2004,isCancelled:false}]});
  const client=new ShipXClient({...config,shipxApiKey:'test-key'},async url=>{
    calls.push(url.pathname);
    if(url.pathname===SHIPPING_HISTORY_ENDPOINT){assert.equal(url.searchParams.get('fromDate'),'2026-11-26T00:00:00+07:00');assert.equal(url.searchParams.get('toDate'),'2026-11-26T16:59:59.999Z');
      return Response.json({data:{batches:[make(1,'2026-11-26T09:00:00+07:00'),make(2,'2026-11-25T22:00:00+07:00'),make(3,'2026-11-27T09:00:00+07:00')]}});}
    assert.equal(url.pathname,'/api/v2/Order/1/detail');return Response.json({data:{orderId:1,companyId,orderType:0,expressDelivery:false}});
  });
  const report=await client.dailyShippedOrders(companyId,now,undefined,1);assert.equal(report.date,'2026-11-26');assert.equal(report.total,1);assert.equal(report.shopee,1);assert.equal(calls.length,2);
});
test('out-of-range history from another company remains rejected before its date is ignored',async()=>{
  const client=new ShipXClient({...config,shipxApiKey:'test-key'},async()=>Response.json({data:{batches:[{summaryPlatformBatchId:1,companyId:202,dateCreated:'2026-11-25T10:00:00+07:00',items:[]}]}}));
  await assert.rejects(client.dailyShippedOrders(companyId,new Date('2026-11-27T15:00:00+07:00')),{reason:'shipping_batch_not_verified'});
});
test('customer shipping replies use the past shipping date instead of changing to OrderDate overview',async t=>{
  const f=setup(t,[companyId]);let called=0;
  const shipx={config,dailyShippedOrders:async(id,now,_signal,offset)=>{called++;assert.equal(id,companyId);assert.equal(offset,1);return {date:reportDates(1,now,offset)[0],shopee:3,lazada:0,tiktok:0,express:0,b2b:0,b2bExpress:0,total:3};}};
  const result=await answerCommand({store:f.store,shipx,groupId,text:'ขอรายงานการจัดส่ง ที่ส่งไปเมื่อวานหน่อย'});
  assert.equal(called,1);assert.match(result.text,/สรุปงานที่จัดส่ง/);assert.match(result.text,/23:59/);assert.doesNotMatch(result.text,/OrderDate/);
});
test('best-selling stock requests are handed off rather than mislabeled as stock quantity overviews',async()=>{
  const question='สต๊อกวันนี้อะไรขายดีสุด';let calls=0;
  assert.deepEqual(parseCommand(question),{type:'help'});assert.deepEqual(await interpret(question,async()=>{calls++;return 'stock_overview';}),{type:'help'});assert.equal(calls,0);
});
test('Admin OAuth test separates token success from mapped-company access without exposing tokens',async t=>{
  const f=setup(t,[202]),{app,worker}=await createApp({config,store:f.store,shipx:f.client,tokens:f.tokens,line:{}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await worker.stop();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:config.adminPassword})});
  const session=await login.json(),headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:config.origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  const result=await (await fetch(base+'/api/admin/shipx/oauth/test',{method:'POST',headers,body:'{}'})).json();
  assert.equal(result.tokenOk,true);assert.equal(result.ok,false);assert.equal(result.access.missingCompanies[0].id,companyId);assert(!JSON.stringify(result).includes('first-access'));
  const settings=await (await fetch(base+'/api/admin/settings',{headers})).json();assert.equal(settings.shipxAccess.missingCompanies.length,1);
  const attention=await (await fetch(base+'/api/admin/attention',{headers})).json();assert.equal(attention.tokenStatus.warning,null);assert.equal(attention.shipxAccess.missingCompanies.length,1);
});
