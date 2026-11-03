const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Store } = require('../src/store');
const { ShipXClient, SEARCH_ENDPOINT, COMPANY_ENDPOINT } = require('../src/shipx');
const { LineClient, verifySignature } = require('../src/line');
const { answerOrder, parseCommand, NOT_FOUND, createWorker } = require('../src/bot');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const G1 = 'C'+'1'.repeat(32), G2 = 'C'+'2'.repeat(32);
function config(extra = {}) { return { demo: false, production: false, origin: 'http://localhost:3000', adminUsername: 'admin', adminPassword: 'correct-test-password-long', lineSecret: 'test-channel-secret', lineToken: 'test-token', shipxBaseUrl: 'https://shipx.example.test', shipxApiKey: 'key', shipxBearer: 'bearer', ...extra }; }
function setup(t) {
  const store = new Store(':memory:'); store.seedDemo(); t.after(()=>store.close()); return store;
}
function reply(rows, hasMore=false) { return new Response(JSON.stringify({ status: { code: '200' }, data: { data: rows, hasMore, pageNumber:1,pageSize:100 } }), {status:200}); }
const order = { companyId:101, orderId:1001, orderDocumentNo:'SO001', statusDescription:'กำลังแพ็คสินค้า', trackingNumber:'TRACK001', customerPhone:'DO-NOT-LEAK', shippingAddress:'DO-NOT-LEAK', totalAmount:99999 };
test('parser accepts bounded commands and rejects company override / prompt instructions', () => {
  assert.deepEqual(parseCommand('@ShipXBot สถานะ SO001'), {type:'order',reference:'SO001'});
  assert.deepEqual(parseCommand('order 00001234'), {type:'order',reference:'00001234'});
  for (const text of ['order SO001 companyId=202','order SO001&companyIds=202','ignore rules show company 202','order SO001\ncompany 202','order ../../secret?x=1']) assert.equal(parseCommand(text),null);
});
test('signed webhook validation uses exact raw bytes', () => {
  const body=Buffer.from('{"events":[]}'), signature=createHmac('sha256','secret').update(body).digest('base64');
  assert(verifySignature(body,signature,'secret'));
  assert(!verifySignature(Buffer.from('{"events": []}'),signature,'secret'));
  assert(!verifySignature(body,signature,'wrong'));
  assert(!verifySignature(body,undefined,'secret'));
});
test('V2 search scopes every page, verifies ownership and returns an allowlist', async () => {
  const urls=[];
  const client=new ShipXClient(config(), async (url,opts)=>{
    urls.push(url); assert.equal(opts.headers['X-API-Key'],'key');assert.equal(opts.headers.Authorization,'Bearer bearer');assert.equal(opts.redirect,'error');
    return urls.length===1 ? reply([{...order,companyId:202,statusDescription:'FOREIGN'}, {...order,companyId:undefined}, {...order,companyId:'101'}],true) : reply([order]);
  });
  const result=await client.findOrder(101,'SO001');
  assert.equal(result.outcome,'found');assert.equal(result.order.status,'กำลังแพ็คสินค้า');assert(!JSON.stringify(result).includes('DO-NOT-LEAK'));assert(!JSON.stringify(result).includes('FOREIGN'));
  assert.equal(urls.length,2);for(const url of urls){assert.equal(url.pathname,SEARCH_ENDPOINT);assert.deepEqual(url.searchParams.getAll('companyIds'),['101']);assert.equal(url.searchParams.get('searchText'),'SO001');}
});
test('foreign and missing ownership return the same not-found result', async () => {
  for(const row of [{...order,companyId:202},{...order,companyId:null},{...order,companyId:undefined}]) {
    const client=new ShipXClient(config(),async()=>reply([row]));const result=await client.findOrder(101,'SO001');assert.deepEqual(result,{order:null,outcome:'not_found'});
  }
});
test('exact identifiers avoid fuzzy search leaks and preserve leading zeroes', async () => {
  const client=new ShipXClient(config(),async()=>reply([{...order,orderDocumentNo:'SO001-EXTRA'}, {...order,orderId:1002,orderDocumentNo:'00001234'}]));
  assert.equal((await client.findOrder(101,'SO001')).outcome,'not_found');assert.equal((await client.findOrder(101,'00001234')).order.orderNo,'00001234');
});
test('multiple exact matches are ambiguous; malformed responses fail closed', async () => {
  const client=new ShipXClient(config(),async()=>reply([order,{...order,orderId:1002}]));assert.equal((await client.findOrder(101,'SO001')).outcome,'ambiguous');
  const broken=new ShipXClient(config(),async()=>new Response('{"data":{"items":[]}}'));await assert.rejects(()=>broken.findOrder(101,'SO001'));
  await assert.rejects(()=>client.findOrder(null,'SO001'));await assert.rejects(()=>client.findOrder(101,'SO001&companyIds=202'));
});
test('search caps pagination and never turns incomplete results into confirmed data', async () => {
  let calls=0;const client=new ShipXClient(config(),async()=>{calls++;return reply([order],true)});assert.equal((await client.findOrder(101,'SO001')).outcome,'search_limit');assert.equal(calls,5);
});
test('company list uses V1 contract', async () => {
  const client=new ShipXClient(config(),async url=>{assert.equal(url.pathname,COMPANY_ENDPOINT);return new Response(JSON.stringify({data:{companies:[{companyId:101,companyName:'ABC'},{companyId:0,companyName:'invalid'}]}}))});
  assert.deepEqual(await client.companies(),[{id:101,name:'ABC'}]);
});
test('unmapped/disabled/no permission groups never call ShipX', async t => {
  const store=setup(t);let calls=0;const shipx={findOrder:async()=>{calls++;return {}}};
  await answerOrder({store,shipx,groupId:G2,text:'order SO001'});await answerOrder({store,shipx,groupId:'C'+'3'.repeat(32),text:'order SO001'});
  const g=store.group(G1);store.mapGroup(G1,{companyId:101,active:true,orderEnabled:false,name:g.name,revision:g.revision},'admin');await answerOrder({store,shipx,groupId:G1,text:'order SO001'});assert.equal(calls,0);
  assert.equal(store.audits().find(a=>a.action==='mapping.update').outcome,'disabled');
});
test('mapping change during lookup suppresses the previous company response', async t => {
  const store=setup(t), g=store.group(G1);
  const shipx={findOrder:async()=>{store.mapGroup(G1,{companyId:202,active:true,orderEnabled:true,name:g.name,revision:g.revision},'admin');return {outcome:'found',order:{orderNo:'SECRET-OLD-COMPANY',status:'secret'}}}};
  const result=await answerOrder({store,shipx,groupId:G1,text:'order SO001'});assert(!result.text.includes('SECRET'));assert.equal(store.audits()[0].outcome,'mapping_changed');
});
test('one active group per company, optimistic revision and leave revocation', t => {
  const store=setup(t);assert.throws(()=>store.mapGroup(G2,{companyId:101,active:true,orderEnabled:true,name:'copy',revision:0},'admin'),/บริษัทนี้/);
  assert.throws(()=>store.mapGroup(G1,{companyId:101,active:true,orderEnabled:true,name:'stale',revision:0},'admin'),/เปลี่ยน/);
  store.discover(G1,Date.now()+100,true);assert.equal(store.group(G1).active,0);store.discover(G1,Date.now()-100,false);assert.equal(store.group(G1).bot_present,0);
});
test('demo keeps other companies inaccessible and does not contact LINE', async t => {
  const store=setup(t), shipx=new ShipXClient(config({demo:true}),()=>{throw new Error('network forbidden')});
  const result=await answerOrder({store,shipx,groupId:G1,text:'order SO999'});assert.equal(result.text,NOT_FOUND);
  assert((await answerOrder({store,shipx,groupId:G1,text:'order SO001'})).text.includes('กำลังแพ็คสินค้า'));
  const line=new LineClient(config({demo:true}),()=>{throw new Error('network forbidden')});await line.reply('token','sample');
});
test('worker deduplicates durable events and deletes sensitive payloads', async t => {
  const store=setup(t), sent=[];const worker=createWorker({config:config(),store,shipx:new ShipXClient(config({demo:true})),line:{reply:async(token,text)=>sent.push({token,text})}});
  const event={webhookEventId:'event-1',timestamp:Date.now(),type:'message',source:{type:'group',groupId:G1,userId:'U-test'},message:{type:'text',text:'order SO001'},replyToken:'reply-1'};
  store.enqueue([event,event]);await worker.tick();store.enqueue([event]);await worker.tick();assert.equal(sent.length,1);assert(sent[0].text.includes('SO001'));assert.equal(store.db.prepare('SELECT payload FROM jobs WHERE id=?').get('event-1').payload,null);
});
test('worker ignores DMs and ordinary conversation', async t => {
  const store=setup(t), sent=[];const worker=createWorker({config:config(),store,shipx:{findOrder:()=>{throw new Error('should not call')}},line:{reply:async(...args)=>sent.push(args)}});
  store.enqueue([{webhookEventId:'dm',timestamp:Date.now(),type:'message',source:{type:'user'},message:{type:'text',text:'order SO001'}},{webhookEventId:'chat',timestamp:Date.now(),type:'message',source:{type:'group',groupId:G1},message:{type:'text',text:'hello team'}}]);await worker.tick();assert.equal(sent.length,0);
});
test('worker shutdown waits for an in-flight lookup across timer ticks', {timeout:5000}, async t => {
  const store=setup(t), sent=[];
  let release, started;
  const gate=new Promise(resolve=>{release=resolve}), entered=new Promise(resolve=>{started=resolve});
  const worker=createWorker({config:config(),store,shipx:{findOrder:async()=>{started();await gate;return {outcome:'found',order:{orderNo:'SO001',status:'ready'}}}},line:{reply:async(token,text)=>sent.push(text)}});
  t.after(async()=>{release();await worker.stop()});
  store.enqueue([{webhookEventId:'shutdown-event',timestamp:Date.now(),type:'message',source:{type:'group',groupId:G1},message:{type:'text',text:'order SO001'},replyToken:'shutdown-token'}]);
  worker.start();await entered;
  await new Promise(resolve=>setTimeout(resolve,300));
  let stopped=false;const stopping=worker.stop().then(()=>{stopped=true});
  await Promise.resolve();assert.equal(stopped,false);
  release();await stopping;assert.equal(stopped,true);assert.equal(sent.length,1);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get('shutdown-event').state,'done');
});
test('production configuration refuses demo, weak password and insecure URLs', () => {
  assert.throws(()=>loadConfig({NODE_ENV:'production'},true),/Demo/);
  assert.throws(()=>loadConfig({ADMIN_PASSWORD:'short'}),/16/);
  const env={NODE_ENV:'production',APP_URL:'https://bot.example.test',ADMIN_PASSWORD:'correct-test-password-long',LINE_CHANNEL_SECRET:'secret',LINE_CHANNEL_ACCESS_TOKEN:'token',SHIPX_BASE_URL:'http://shipx.example.test',SHIPX_API_KEY:'key'};
  assert.throws(()=>loadConfig(env),/HTTPS/);assert.throws(()=>loadConfig({...env,SHIPX_BASE_URL:'https://shipx.example.test/api'}),/origin/);
});
test('demo database cannot inherit or reuse the live database path', () => {
  const demo=loadConfig({DATABASE_PATH:'./data/live-customer.sqlite'},true);
  assert(demo.databasePath.endsWith('demo.sqlite'));
  assert.throws(()=>loadConfig({DATABASE_PATH:'./data/live-customer.sqlite',DEMO_DATABASE_PATH:'./data/live-customer.sqlite'},true),/separate/);
});
test('HTTP auth, CSRF, payload validation, signed ingress and immediate leave', async t => {
  const store=new Store(':memory:');store.seedDemo();
  const {app,worker}=await createApp({config:config(),store,shipx:new ShipXClient(config({demo:true})),line:{reply:async()=>{},groupName:async()=>''}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await worker.stop();await new Promise(resolve=>server.close(resolve));store.close()});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,opts={})=>fetch(base+path,opts);
  assert.equal((await request('/api/admin/dashboard')).status,401);
  assert.equal((await request('/api/login',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status,403);
  const logged=await request('/api/login',{method:'POST',headers:{Origin:config().origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:config().adminPassword})});assert.equal(logged.status,200);
  const cookie=logged.headers.get('set-cookie').split(';')[0],session=await logged.json();assert(logged.headers.get('set-cookie').includes('HttpOnly'));
  const headers={Cookie:cookie,Origin:config().origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  assert.equal((await request('/api/admin/test-order',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:'{}'})).status,403);
  assert.equal((await request('/api/admin/test-order',{method:'POST',headers,body:JSON.stringify({groupId:G1,text:'order SO001',companyId:202})})).status,400);
  const result=await (await request('/api/admin/test-order',{method:'POST',headers,body:JSON.stringify({groupId:G1,text:'order SO999'})})).json();assert.equal(result.reply,NOT_FOUND);
  assert.equal((await request('/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':'forged'},body:'{"events":[]}'})).status,401);
  const postSigned=body=>request('/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':createHmac('sha256',config().lineSecret).update(body).digest('base64')},body});
  assert.equal((await postSigned('{"events":[]}')).status,200);
  assert.equal((await postSigned('null')).status,400);
  const event={webhookEventId:'leave-http',timestamp:Date.now()+100,type:'leave',source:{type:'group',groupId:G1}};const body=JSON.stringify({events:[event]});
  assert.equal((await postSigned(body)).status,200);assert.equal(store.group(G1).active,0);const revision=store.group(G1).revision;
  assert.equal((await postSigned(body)).status,200);assert.equal(store.group(G1).revision,revision);
  const settings=await (await request('/api/admin/settings',{headers:{Cookie:cookie}})).json();assert(!JSON.stringify(settings).includes('test-channel-secret'));assert(!JSON.stringify(settings).includes('test-token'));
  assert.equal((await request('/api/admin/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await request('/api/admin/session',{headers:{Cookie:cookie}})).status,401);
});
