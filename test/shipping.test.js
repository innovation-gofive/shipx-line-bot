const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Store } = require('../src/store');
const { ShipXClient, SHIPPING_ENDPOINT } = require('../src/shipx');
const { LineClient, addressedCommand } = require('../src/line');
const { createClassifier, interpret, parseCommand } = require('../src/intent');
const { createNotifications } = require('../src/notifications');
const { answerCommand, createWorker } = require('../src/bot');
const { shippingReply, stockReply } = require('../src/replies');
const groupId = 'C'+'1'.repeat(32), now = new Date('2026-11-05T09:00:00Z');
const config = { shipxBaseUrl:'https://example.test', shippingDateIsDueDate:true };
const response = data => Response.json(data);
const row = (orderId, status) => ({ orderId, companyId:101, shippingDate:'2026-11-05T08:00:00+07:00', orderDocumentNo:'SO'+orderId, status, shippingPlatform:'Shopee', customerPhone:'SECRET', shippingAddress:'SECRET' });
const page = (rows, hasMore=false) => response({data:{data:rows,hasMore}});
function setup(t) {
  const store=new Store(':memory:'); store.seedDemo(); t.after(()=>store.close());
  const map=(extra={}) => store.mapGroup(groupId,{companyId:101, active:true, orderEnabled:true,stockEnabled:true,reportEnabled:true,alertsEnabled:true,name:'Test',revision:store.group(groupId).revision,...extra},'admin');
  map(); return {store,map};
}

test('shipping progress scans all pages using shipping dates, never order creation dates', async () => {
  let calls=0;
  const client=new ShipXClient(config,async (url, options)=>{
    assert.equal(url.pathname,SHIPPING_ENDPOINT);assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);
    assert.deepEqual(body.companyIds,[101]);
    assert.equal(body.shippingStartDate,'2026-11-05T00:00:00+07:00');
    assert.equal(body.shippingEndDate,'2026-11-05T23:59:59.999+07:00');
    assert(!Object.hasOwn(body,'startDate')); assert(!Object.hasOwn(body,'endDate'));
    assert.equal(body.pageNumber,++calls);
    return calls===1 ? page([row(1,2003),row(2,2004),row(3,2005),row(4,4001),row(5,4002)],true) :
      page([row(6,1001),row(7,2002),row(8,3004),row(9,3001),row(10,5001),row(11,9999)]);
  });
  const result=await client.shippingProgress(101,now);
  assert.deepEqual([result.scheduled,result.due,result.packed,result.toPack,result.readyToShip,result.shipped,result.cancelled,result.returns,result.unknown,result.packedPercent],[11,9,5,3,2,3,1,1,1,55.6]);
  assert(!JSON.stringify(result).includes('SECRET'));
  assert.equal(calls,2);
});

test('shipping totals fail closed on wrong/missing owner, wrong date, malformed/duplicate rows or incomplete pagination', async () => {
  for(const broken of [{...row(1,2002),companyId:202},{...row(1,2002),companyId:undefined},{...row(1,2002),shippingDate:'2026-11-04T23:59:00+07:00'},{...row(1,2002),status:undefined}]) {
    const client=new ShipXClient(config,async()=>page([broken]));
    await assert.rejects(client.shippingProgress(101,now),/not verified/);
  }
  const duplicate=new ShipXClient(config,async()=>page([row(1,2002)],true));
  await assert.rejects(duplicate.shippingProgress(101,now),/not verified/);
  const empty=new ShipXClient(config,async()=>page([],true));
  await assert.rejects(empty.shippingProgress(101,now),/complete scan/);
  const bad=new ShipXClient(config,async()=>response({data:{items:[]}}));
  await assert.rejects(bad.shippingProgress(101,now),/pagination/);
  const incomplete=new ShipXClient(config,async()=>response({data:{data:[row(1,2002)],totalCount:100,hasMore:false}}));
  await assert.rejects(incomplete.shippingProgress(101,now),/Incomplete/);
});

test('shipping function selection dispatches to the scoped API and calculates pack totals', async t => {
  const {store}=setup(t);
  const calls=[];
  const classify=createClassifier({openaiApiKey:'fake',openaiModel:'model'},async (_,options)=>{
    const input=JSON.parse(options.body);
    assert(input.tools.some(tool=>tool.name==='get_shipping_progress'));
    calls.push('ai');
    return response({output:[{type:'function_call',name:'get_shipping_progress',arguments:'{}'}]});
  });
  const reply=await answerCommand({
    store,groupId,text:'ออเดอร์วันนี้ที่ต้องส่งมีเท่าไหร่ แล้วตอนนี้แพ็คไปเท่าไหร่', classify,
    shipx:{shippingProgress:async companyId=>{assert.equal(companyId,101);calls.push('shipx');return new ShipXClient({demo:true}).shippingProgress(101,now)}},
  });
  assert.deepEqual(calls,['ai','shipx']);
  assert.match(reply.text,/ต้องส่งทั้งหมด: 8/);
  assert.match(reply.text,/แพ็คเสร็จแล้ว: 4/);
  assert.match(reply.text,/50%/);
  assert.equal(reply.message.type,'flex');
  assert.equal(store.audits()[0].action,'report.shipping');
});

test('tool calls reject injected scope, unsupported functions and arguments', async () => {
  for(const call of [
    {name:'lookup_order',arguments:'{"companyId":202}'},
    {name:'arbitrary_http_get',arguments:'{}'},
    {name:'get_sales_report',arguments:'{}'},
  ]) {
    const classify=createClassifier({openaiApiKey:'fake',openaiModel:'model'},async(_,options)=>{
      assert(!JSON.parse(options.body).tools.some(t=>t.name==='get_sales_report'));
      return response({output:[{type:'function_call',...call}]});
    });
    assert.equal(await classify(['ออเดอร์','[REF_1]'],['order']),null);
  }
  assert.deepEqual(parseCommand('วันนี้ต้องส่งกี่ออเดอร์ แพ็คไปเท่าไหร่'),{type:'shipping',days:1});
  assert.deepEqual(parseCommand('ออเดอร์ที่กำหนดส่งวันนี้แต่ยังแพ็คไม่เสร็จ'),{type:'shipping_issues',days:1});
  assert.deepEqual(await interpret('ออเดอร์กำหนดส่งเมื่อวาน',null),{type:'shipping',days:1,offset:1});
});

test('only genuine bot mentions can start customer work; unmentioned messages call neither ShipX nor AI', async t => {
  const {store}=setup(t); let calls=0;
  const worker=createWorker({config:{demo:true},store,shipx:{findOrder:async()=>{calls++;}},classify:async()=>{calls++;},line:{reply:async()=>{calls++;}}});
  const mention={index:0,length:10,type:'user',isSelf:true,userId:'BOT'};
  assert.equal(addressedCommand({type:'text',text:'@ShipX Bot order SO1'},'BOT'),null);
  assert.equal(addressedCommand({type:'text',text:'@ShipX Bot order SO1',mention:{mentionees:[{...mention,isSelf:false}]}},'BOT'),null);
  assert.equal(addressedCommand({type:'text',text:'@ShipX Bot order SO1',mention:{mentionees:[mention]}},'BOT'),'order SO1');
  store.enqueue([{webhookEventId:'bare',timestamp:Date.now(),type:'message',source:{type:'group',groupId},message:{type:'text',text:'order SO1'},replyToken:'token'}]);
  await worker.tick();assert.equal(calls,0);
});

test('stock output contains sellable quantity only, regardless of fields in upstream data', () => {
  const reply=stockReply({sku:'SKU1',name:'Product',ready:24,incoming:999,reserved:88});
  const output=JSON.stringify(reply);
  assert.match(output,/24/);assert.doesNotMatch(output,/incoming|reserved|999|88|รอจัดเก็บ|รอเข้า|จอง/);
});

test('16:00 notification is opt-in, company scoped, once per date, and survives a scheduler restart', async t => {
  const {store}=setup(t);const sent=[];let hour=new Date('2026-11-05T08:59:00Z'),apiCalls=0;
  const deps={config,store,clock:()=>hour,shipx:{shippingProgress:async company=>{assert.equal(company,101);apiCalls++;return new ShipXClient({demo:true}).shippingProgress(company,hour)}},line:{push:async(id,message,key)=>sent.push({id,message,key})}};
  let scheduler=createNotifications(deps);
  await scheduler.tick();assert.equal(apiCalls,0);
  hour=now;await scheduler.tick();await scheduler.tick();
  scheduler=createNotifications(deps);await scheduler.tick();
  assert.equal(apiCalls,1);assert.equal(sent.length,1);assert.equal(sent[0].id,groupId);assert.match(sent[0].message.altText,/ต้องติดตาม/);
  assert.match(sent[0].key,/^[a-f0-9-]{36}$/);
  assert.equal(store.db.prepare('SELECT payload FROM notifications').get().payload,null);
  hour=new Date('2026-11-06T09:00:00Z');await scheduler.tick();assert.equal(sent.length,2);
});

test('notification retries use the identical payload and key and stop on permission revocation', async t => {
  const {store,map}=setup(t);let hour=now,attempts=0,apiCalls=0;const requests=[];
  const deps={config,store,clock:()=>hour,shipx:{shippingProgress:async()=>{apiCalls++;return new ShipXClient({demo:true}).shippingProgress(101,hour)}},line:{push:async(...args)=>{requests.push(JSON.stringify(args));if(++attempts===1)throw new Error('timeout')}}};
  let scheduler=createNotifications(deps);await scheduler.tick();await scheduler.tick();
  hour=new Date(now.getTime()+61000);
  scheduler=createNotifications(deps);await scheduler.tick();
  assert.equal(apiCalls,1);assert.equal(attempts,2);assert.equal(requests[0],requests[1]);
  store.db.exec('DELETE FROM notifications');
  attempts=0;await scheduler.tick();map({alertsEnabled:false});hour=new Date(now.getTime()+180000);await scheduler.tick();
  assert.equal(attempts,1);
});

test('groups use their own Bangkok times and a later time change does not repeat the daily alert', async t => {
  const {store,map} = setup(t);
  map({alertsTime:'10:25'});
  const secondGroupId = 'C' + '2'.repeat(32);
  store.mapGroup(secondGroupId, {
    companyId:202, active:true, reportEnabled:true, alertsEnabled:true, alertsTime:'11:40',
    orderEnabled:false, name:'Second group', revision:store.group(secondGroupId).revision,
  }, 'admin');
  let currentTime = new Date('2026-11-05T03:24:59Z');
  const report = await new ShipXClient({demo:true}).shippingProgress(101, now);
  const calls = [], sent = [];
  const scheduler = createNotifications({
    config, store, clock:() => currentTime,
    shipx:{shippingProgress:async companyId => { calls.push(companyId); return report; }},
    line:{push:async (id, message) => sent.push({id, message})},
  });
  await scheduler.tick();
  assert.deepEqual(calls, []);
  currentTime = new Date('2026-11-05T03:25:00Z');
  await scheduler.tick();
  assert.deepEqual(calls, [101]);
  assert.match(JSON.stringify(sent[0].message), /แจ้งเตือนรอบ 10:25/);
  map({alertsTime:'11:40'});
  currentTime = new Date('2026-11-05T04:40:00Z');
  await scheduler.tick();
  assert.deepEqual(calls, [101,202]);
  assert.deepEqual(sent.map(item => item.id), [groupId,secondGroupId]);
  assert.match(JSON.stringify(sent[1].message), /แจ้งเตือนรอบ 11:40/);
  currentTime = new Date('2026-11-06T04:55:00Z');
  await scheduler.tick();
  assert.deepEqual(calls, [101,202]);
});

test('no automatic alert when no unfinished orders; never send after remapping during lookup', async t => {
  const {store,map}=setup(t);let sent=0;
  const base={config,store,clock:()=>now,line:{push:async()=>sent++}};
  const empty=await new ShipXClient({demo:true}).shippingProgress(202,now);
  await createNotifications({...base,shipx:{shippingProgress:async()=>empty}}).tick();
  assert.equal(sent,0);assert.equal(store.db.prepare('SELECT state FROM notifications').get().state,'no_issues');
  store.db.exec('DELETE FROM notifications');
  await createNotifications({...base,shipx:{shippingProgress:async()=>{map({companyId:202});return new ShipXClient({demo:true}).shippingProgress(101,now)}}}).tick();
  assert.equal(sent,0);assert.equal(store.db.prepare('SELECT state FROM notifications').get().state,'cancelled');
});

test('LINE push uses a retry key and treats an already accepted retry as successful', async () => {
  const message=shippingReply(await new ShipXClient({demo:true}).shippingProgress(101,now),true,'16:00').message,key=randomUUID();
  const client=new LineClient({lineToken:'fake'},async(url,options)=>{
    assert.equal(url,'https://api.line.me/v2/bot/message/push');
    assert.equal(options.headers['X-Line-Retry-Key'],key);
    assert.deepEqual(JSON.parse(options.body),{to:groupId,messages:[message]});
    return new Response('',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
  });
  await client.push(groupId,message,key);
});

test('LINE push passes through the ordered Flex and text messages of a follow-up batch', async () => {
  const card = shippingReply(await new ShipXClient({demo:true}).shippingProgress(101, now), true, '16:00').message;
  const messages = [card, { type: 'text', text: 'SO001' }], key = randomUUID();
  const client = new LineClient({ lineToken: 'fake' }, async (url, options) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(options.headers['X-Line-Retry-Key'], key);
    assert.deepEqual(JSON.parse(options.body), { to: groupId, messages });
    return new Response('{}');
  });
  await client.push(groupId, messages, key);
});
