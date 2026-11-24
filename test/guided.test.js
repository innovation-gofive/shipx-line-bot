const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Store } = require('../src/store');
const { ShipXClient, SHIPPING_ENDPOINT } = require('../src/shipx');
const { orderPage } = require('../src/order-page');
const { parseCommand } = require('../src/intent');
const { answerCommand } = require('../src/bot');
const { conversationReply } = require('../src/conversation');
const { helpReply, choiceByKey } = require('../src/menus');
const { orderReply, overviewReply, dailyShippedReply } = require('../src/replies');
const { presentationSpec, applyPresentation } = require('../src/ai-response');
const { createApp } = require('../src/app');
const { createNotifications } = require('../src/notifications');
const groupId = 'C' + '1'.repeat(32), otherGroupId = 'C' + '2'.repeat(32);
const config = { origin:'https://bot.example.test', adminUsername:'admin', adminPassword:'a-good-test-password-long',
  lineSecret:'test-secret', lineToken:'fake', shipxApiKey:'key', shipxBaseUrl:'https://api.example.test', shippingDateIsDueDate:true };
function setup(t) { const store = new Store(':memory:'); store.seedDemo(); t.after(() => store.close()); return store; }

test('previously unsupported audit phrases route to monitor, stock overview, reorder and packing', () => {
  for (const [question, type] of [
    ['มอนิเตอร์','overview'], ['มอนิเตอร์ออเดอร์','overview'], ['มอนิเตอร์สต็อกหน่อย','stock_overview'],
    ['ภาพรวมสต็อก','stock_overview'], ['สต็อกSKU ไหนใกล้หมด','stock_reorder'], ['สต็อกไหนใกล้หมดบ้าง','stock_reorder'],
    ['สต็อกไหนถึงจุด reorder','stock_reorder'], ['ความคืบหน้าแพ็ค','shipping'], ['ดูรายงานการจัดส่งวันนี้หน่อย','daily_shipped'],
  ]) assert.equal(parseCommand(question)?.type, type, question);
});

test('greetings with names and compliments are friendly, company-scoped and mention ShipX', t => {
  const store = setup(t), group = store.group(groupId), userId = 'U'+'a'.repeat(32);
  assert.match(conversationReply({text:'สวัสดีผมชื่อ อาร์ม',group,userId,store}), /อาร์ม.*|ShipX/);
  assert.equal(store.rememberedName(group,userId),'อาร์ม');
  assert.match(conversationReply({text:'เก่งมาก',group,userId,store}), /ยินดี/);
  assert.match(conversationReply({text:'แนะนำตัวหน่อยครับ',group,userId,store}), /ทำงานร่วมกับ ShipX/);
});

test('help has exactly three authorized actions and action tokens cannot cross company/group or revision', async t => {
  const store = setup(t), group = store.group(groupId), reply = helpReply(store, group);
  const buttons = reply.message.contents.footer.contents.filter(c => c.type === 'button');
  assert.deepEqual(buttons.map(b=>b.action.label), ['มอนิเตอร์ออเดอร์','ภาพรวมสต็อก','รายงานการจัดส่ง']);
  const data = buttons[0].action.data;
  assert.equal(store.botAction(data, groupId), 'orders');
  assert.equal(store.botAction(data, otherGroupId), null);
  assert.equal(store.botAction(data, groupId, Date.now()+86400001), null);
  store.mapGroup(groupId,{companyId:101,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:true,name:'edited',revision:group.revision},'admin');
  assert.equal(store.botAction(data, groupId), null);
});

test('guided queries still enforce company permissions before reading stock', async t => {
  const store = setup(t), group = store.group(groupId);
  store.mapGroup(groupId,{companyId:101,active:true,orderEnabled:true,reportEnabled:true,stockEnabled:false,name:group.name,revision:group.revision},'admin');
  let calls = 0;
  const reply = await answerCommand({store,groupId,text:'ภาพรวมสต็อก',shipx:{stockOverview:()=>{calls++;}}});
  assert.match(reply.text,/ไม่มีสิทธิ์/); assert.equal(calls,0);
});

test('Reorder follow-up pages are server-bound and expose the next SKUs instead of repeating the first page', async t => {
  const store=setup(t);
  const report={reorderSkus:10,missingThresholdSkus:0,reorder:Array.from({length:10},(_,i)=>({sku:'SKU-'+i,ready:i,reorderPoint:20}))};
  const shipx={stockOverview:async()=>report};
  const first=await answerCommand({store,groupId,text:'สต็อกไหนใกล้หมดบ้าง',shipx});
  const button=first.message.contents.footer.contents.find(c=>c.action?.label==='ดู SKU ถัดไป');
  const choice=choiceByKey(store.botAction(button.action.data,groupId));
  assert.equal(choice.page,1);
  const second=await answerCommand({store,groupId,text:choice.command,actionPage:choice.page,shipx});
  assert.match(second.text,/SKU-8/);assert.match(second.text,/SKU-9/);assert(!second.text.includes('SKU-0'));
  assert(!second.message.contents.footer.contents.some(c=>c.action?.label==='ดู SKU ถัดไป'));
});

test('order pagination accepts count-based deployed contracts without guessing completeness from page length', async () => {
  const rows = [{orderId:1}];
  for (const json of [
    {data:{items:rows,totalCount:1,pageNumber:1,pageSize:100}},
    {data:rows,totalCount:1,pageNumber:1,pageSize:100},
    {data:{orders:rows,pagination:{totalCount:1,currentPage:1,totalPages:1}}},
  ]) assert.deepEqual(orderPage(json,1,100),{rows,hasMore:false,totalCount:1});
  assert.throws(()=>orderPage({data:{items:rows}},1,100),/pagination/);
  const ids = [];
  const client = new ShipXClient(config,async(url,options)=>{
    assert.equal(url.pathname,SHIPPING_ENDPOINT);
    const p=JSON.parse(options.body).pageNumber;
    return Response.json({data:{items:Array.from({length:p===1?100:1},(_,i)=>({orderId:(p-1)*100+i+1,companyId:101,status:2002,shippingDate:'2026-11-23T00:00:00+07:00'})),pageNumber:p,pageSize:100,totalCount:101}});
  });
  ids.push(...await client.ordersDueForShipping(101,'2026-11-23'));
  assert.equal(ids.length,101);
});

function stockClient(change = {}) {
  return new ShipXClient(config,async(url)=>{
    if(url.pathname.includes('/Product/variant')) return Response.json({data:{pageNumber:1,totalPages:1,variants:[
      {variant:{productVariantId:1,productMasterId:10,sku:'SKU-A'},productMaster:{productMasterId:10,companyId:101}},
      {variant:{productVariantId:2,productMasterId:10,sku:'SKU-B'},productMaster:{productMasterId:10,companyId:101}},
    ]}});
    assert.equal(url.searchParams.get('companyIds'),'101');
    return Response.json({items:[
      {productVariantId:1,productMasterId:10,sku:'SKU-A',currentStock:20,reorderPoint:20,incoming:999,...change},
      {productVariantId:2,productMasterId:10,sku:'SKU-B',currentStock:0,reorderPoint:10},
    ],pagination:{currentPage:1,totalPages:1,totalCount:2}});
  });
}
test('stock overview verifies catalog ownership and uses sellable quantity at the inclusive reorder boundary', async () => {
  const report = await stockClient().stockOverview(101);
  assert.equal(report.reorderSkus,2);
  assert.equal(report.readySkus,1);
  assert.equal(report.outOfStockSkus,1);
  assert(!JSON.stringify(report).includes('incoming'));
  await assert.rejects(stockClient({productVariantId:99}).stockOverview(101),{reason:'stock_identity_not_verified'});
  await assert.rejects(stockClient({companyId:202}).stockOverview(101),{reason:'stock_identity_not_verified'});
  assert.equal((await stockClient({reorderPoint:null}).stockOverview(101)).missingThresholdSkus,1);
});

test('status colour survives AI layout and daily cards hide zero channels while retaining platform logos and total', () => {
  const reply=orderReply({orderNo:'SO001',status:'กำลังแพ็คสินค้า'},'Company A');
  assert.equal(reply.message.contents.header.backgroundColor,'#F3E8FF');
  const spec=presentationSpec(reply,'order');
  const rendered=applyPresentation(reply,'order',{title:spec.titles[0],summaryTemplate:spec.templates[0],density:'compact',sectionOrder:spec.sections.map(s=>s.id),rowOrder:spec.sections.flatMap(s=>s.rows)});
  assert.equal(rendered.message.contents.header.backgroundColor,'#F3E8FF');
  const card=dailyShippedReply({date:'2026-11-23',shopee:3,lazada:0,tiktok:2,express:0,b2b:1,total:6},'Company A','18:00',config.origin);
  const str=JSON.stringify(card.message);
  assert(!str.includes('Lazada')); assert(!str.includes('Express (B2C)'));
  assert(str.includes('/assets/platforms/shopee.png')); assert(str.includes('/assets/platforms/tiktok.png'));
  assert.match(card.text,/Total: 6/);
});

test('overview displays every mutually exclusive bucket and reconciles the 117-order example', () => {
  const reply=overviewReply([{date:'2026-11-23',total:117,cancelled:0,unpacked:35,awaitingShipment:1,complete:80,attention:0,unknown:1,pendingStatuses:[]}]);
  assert.match(reply.text,/ปิดงานแล้ว: 80/); assert.match(reply.text,/ต้องตรวจเพิ่ม: 1/);
  const day=reply.view.sections[0].rows;
  assert.equal(day.slice(3).reduce((n,[,v])=>n+Number(v),0),117);
});

test('09:00 reorder schedules are opt-in, independent per group and survive a scheduler restart', async t => {
  const store=setup(t), first=store.group(groupId);
  store.mapGroup(groupId,{companyId:101,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:false,stockAlertsEnabled:true,stockAlertsTime:'09:00',name:'A',revision:first.revision},'admin');
  store.mapGroup(otherGroupId,{companyId:202,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:false,stockAlertsEnabled:true,stockAlertsTime:'10:00',name:'B',revision:store.group(otherGroupId).revision},'admin');
  const sent=[];let now=new Date('2026-11-23T09:00:00+07:00');
  const deps={config,store,clock:()=>now,shipx:{stockOverview:async()=>({reorderSkus:1,reorder:[{sku:'SKU-A',ready:1,reorderPoint:2}],missingThresholdSkus:0})},line:{push:async id=>sent.push(id)}};
  await createNotifications(deps).tick(); assert.deepEqual(sent,[groupId]);
  await createNotifications(deps).tick(); assert.deepEqual(sent,[groupId]);
  now=new Date('2026-11-23T10:00:00+07:00');
  await createNotifications(deps).tick(); assert.deepEqual(sent,[groupId,otherGroupId]);
  assert.throws(()=>store.mapGroup(groupId,{companyId:101,active:true,stockEnabled:true,stockAlertsEnabled:true,stockAlertsTime:'24:00',name:'A',revision:store.group(groupId).revision},'admin'),/เวลา/);
});

test('Reorder notification suppresses an in-flight result after a company change and does not call missing thresholds healthy', async t => {
  const store=setup(t);
  const map=extra=>store.mapGroup(groupId,{companyId:101,active:true,orderEnabled:true,stockEnabled:true,stockAlertsEnabled:true,reportEnabled:false,stockAlertsTime:'09:00',name:'A',revision:store.group(groupId).revision,...extra},'admin');
  map({});let sent=0;
  const deps={config,store,clock:()=>new Date('2026-11-23T09:00:00+07:00'),line:{push:async()=>sent++}};
  await createNotifications({...deps,shipx:{stockOverview:async()=>{map({companyId:202});return {reorderSkus:1,reorder:[{sku:'old-company-sku',ready:0,reorderPoint:1}]};}}}).tick();
  assert.equal(sent,0);
  const second=setup(t), group=second.group(groupId);
  second.mapGroup(groupId,{companyId:101,active:true,orderEnabled:true,stockEnabled:true,stockAlertsEnabled:true,reportEnabled:false,name:'A',revision:group.revision},'admin');
  await createNotifications({...deps,store:second,shipx:{stockOverview:async()=>({reorderSkus:0,missingThresholdSkus:1,reorder:[]})}}).tick();
  assert.equal(second.db.prepare('SELECT state FROM stock_notifications').get().state,'configuration_required');
  assert.equal(sent,0);
});

test('signed LINE postbacks work without a mention but forged/copied actions and unmentioned greetings do not run', async t => {
  const store=setup(t), sent=[];
  const {app,worker}=await createApp({config,store,shipx:new ShipXClient({demo:true}),line:{reply:async(_token,_text,message)=>sent.push(message)}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await worker.stop();await new Promise(r=>server.close(r));});
  const data=helpReply(store,store.group(groupId)).message.contents.footer.contents.find(c=>c.type==='button').action.data;
  const event=(id,group,postback)=>({webhookEventId:id,timestamp:Date.now(),replyToken:id,type:'postback',source:{type:'group',groupId:group},postback:{data:postback}});
  const body=JSON.stringify({events:[event('copied',otherGroupId,data),event('forged',groupId,'shiny:invalid'),event('valid',groupId,data),
    {webhookEventId:'greeting',timestamp:Date.now(),replyToken:'greeting',type:'message',source:{type:'group',groupId},message:{type:'text',text:'สวัสดี'}}]});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':createHmac('sha256',config.lineSecret).update(body).digest('base64')},body});
  assert.equal(response.status,200);await worker.tick();assert.equal(sent.length,1);assert.equal(sent[0].type,'flex');
  assert(store.audits().some(row=>row.question==='[กดการ์ด] มอนิเตอร์ออเดอร์'));
  const queued=JSON.stringify({events:[event('revoked-in-queue',groupId,data)]});
  const accepted=await fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':createHmac('sha256',config.lineSecret).update(queued).digest('base64')},body:queued});
  assert.equal(accepted.status,200);
  const group=store.group(groupId);
  store.mapGroup(groupId,{companyId:202,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:true,name:'Changed company',revision:group.revision},'admin');
  await worker.tick();assert.equal(sent.length,1,'queued button must be revoked before the new company can be queried');
});
