const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Store } = require('../src/store');
const { answerCommand } = require('../src/bot');
const { ShipXClient } = require('../src/shipx');
const { tokenSettings, tokenHealth } = require('../src/shipx-token');
const { createApp } = require('../src/app');
const { createNotifications } = require('../src/notifications');
const { handoffReply } = require('../src/replies');
const groupId='C'+'1'.repeat(32), adminGroup='C'+'a'.repeat(32), user='U'+'b'.repeat(32);
const config={origin:'http://localhost:3000',adminUsername:'admin',adminPassword:'long-test-password',lineSecret:'test-secret',lineToken:'fake',shipxApiKey:'fake'};
function setup(t){const store=new Store(':memory:');store.seedDemo();store.discover(adminGroup,Date.now());store.rename(adminGroup,'ทีม Admin');t.after(()=>store.close());return store;}
const request=(store,extra={})=>answerCommand({store,shipx:new ShipXClient({demo:true}),groupId,actor:user,text:'ช่วยตรวจเรื่องพิเศษให้หน่อย',escalate:true,requestId:'event-one',...extra});
const caseInput=store=>({requestId:'case-one',group:store.group(groupId),actor:user,question:'คำถามจากลูกค้า',reason:'unsupported'});
const enable=store=>store.support.saveSettings({enabled:true,groupId:adminGroup},'admin');

test('JWT health warns at 24 hours, at expiry, and never guesses an opaque or API-key expiry',()=>{
  const now=Date.parse('2026-11-23T09:00:00+07:00'),status={configured:true,expiresAt:now+86400000};
  assert.equal(tokenHealth(status,now).warning,'expiring');assert.equal(tokenHealth({...status,expiresAt:now+86400001},now).warning,null);
  assert.equal(tokenHealth({...status,expiresAt:now},now).warning,'expired');assert.equal(tokenHealth({...status,expiresAt:null},now).warning,null);
  assert.equal(tokenHealth({configured:false,error:'token_storage_unreadable'},now).warning,'unreadable');
  assert.equal(tokenSettings({shipxApiKey:'key',shipxBearer:'expired.jwt.value'},null,now).warning,null);
  assert.equal(tokenSettings({},null,now).warning,'missing');
});
test('unanswered customer questions persist with an opaque-event dedupe and a customer reference',async t=>{
  const store=setup(t),reply=await request(store);
  assert.match(reply.text,/รอทางแอดมินตรวจสอบเพิ่มเติม/);assert.match(reply.text,/SH-000001/);
  const row=store.support.list().rows[0];assert.equal(row.question,'ช่วยตรวจเรื่องพิเศษให้หน่อย');assert.equal(row.company_id,101);assert.equal(row.actor,user);
  await request(store);assert.equal(store.support.counts().pending,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM admin_alert_jobs').get().n,1);
});
test('help, greetings, verified not-found, AI presentation fallback and Admin previews do not open cases',async t=>{
  const store=setup(t);
  for(const text of ['help','','สวัสดี','order NO-SUCH-ORDER'])await request(store,{text,requestId:text||'empty'});
  await request(store,{escalate:false});
  await request(store,{text:'order SO001',present:async reply=>({reply,outcome:'fallback'})});
  assert.equal(store.support.counts().pending,0);
});
test('ShipX failure is handed off without exposing private upstream bodies, and mapping changes suppress handoff',async t=>{
  const store=setup(t);
  const reply=await request(store,{text:'order SO001',shipx:{findOrder:async()=>{throw Object.assign(new Error('PRIVATE-RESPONSE-BODY'),{statusCode:401});}}});
  assert.match(reply.text,/รอแอดมิน/);assert.doesNotMatch(JSON.stringify(store.support.list()),/PRIVATE-RESPONSE-BODY/);
  const group=store.group(groupId);
  await request(store,{requestId:'mapping-change',text:'order SO001',shipx:{findOrder:async()=>{
    store.mapGroup(groupId,{companyId:202,active:true,orderEnabled:true,stockEnabled:true,reportEnabled:true,name:'New',revision:group.revision},'admin');throw new Error('private');
  }}});
  assert.equal(store.support.counts().pending,1);
});
test('Admin group requires a discovered, present and unmapped group',t=>{
  const store=setup(t);
  assert.throws(()=>store.support.saveSettings({enabled:true,groupId},'admin'),{status:400});
  assert.throws(()=>store.support.saveSettings({enabled:true,groupId:'C'+'f'.repeat(32)},'admin'),{status:400});
  assert.equal(enable(store).ready,true);assert.equal(store.stats().pending,1);store.discover(adminGroup,Date.now()+1,true);assert.equal(store.support.settings().ready,false);
});
test('Admin LINE notifications retry with the same key, dedupe and survive a notifier restart',async t=>{
  const store=setup(t);enable(store);store.support.create(caseInput(store));const sent=[];let now=Date.now();
  const line={push:async(to,message,key)=>{sent.push({to,message,key});if(sent.length===1)throw Object.assign(new Error('network'),{retryable:true});}};
  await store.support.flush(line,config.origin,now);assert.equal(store.support.list().rows[0].alert_state,'pending');
  await store.support.flush(line,config.origin,now+61000);await store.support.flush(line,config.origin,now+62000);
  assert.equal(sent.length,2);assert.equal(sent[0].key,sent[1].key);assert.equal(sent[1].to,adminGroup);
  assert.match(JSON.stringify(sent[1].message),/คำถามจากลูกค้า/);assert.equal(store.support.list().rows[0].alert_state,'sent');
});
test('closed cases, revoked Admin destinations and changed destinations cannot send pending private questions',async t=>{
  const store=setup(t);enable(store);store.support.create(caseInput(store));let calls=0;
  const line={push:async()=>{calls++;throw Object.assign(new Error('retry'),{retryable:true});}};
  await store.support.flush(line,config.origin);assert.equal(calls,1);
  store.support.saveSettings({enabled:false,groupId:adminGroup},'admin');await store.support.flush(line,config.origin,Date.now()+61000);assert.equal(calls,1);
  const other='C'+'c'.repeat(32);store.discover(other,Date.now());store.support.saveSettings({enabled:true,groupId:other},'admin');
  await store.support.flush(line,config.origin,Date.now()+61000);assert.equal(calls,1);assert.equal(store.support.list().rows[0].alert_state,'cancelled');
  const item=store.support.create({...caseInput(store),requestId:'closed'});store.support.update(item.id,{status:'resolved',note:'ตอบแล้ว',version:0},'admin');
  await store.support.flush(line,config.origin,Date.now()+62000);assert.equal(calls,1);
});
test('token alerts dedupe by credential metadata and severity, and scheduler sends only to the Admin group',async t=>{
  const store=setup(t);enable(store);const now=new Date('2026-11-23T09:00:00+07:00'),expiresAt=now.getTime()+3600000,sent=[];
  const tokens={status:()=>({saved:true,configured:true,source:'settings',updatedAt:1,expiresAt})};
  const deps={config,store,shipx:{},line:{push:async(to,message)=>sent.push({to,message})},tokens,clock:()=>now};
  await createNotifications(deps).tick();await createNotifications(deps).tick();assert.equal(sent.length,1);assert.equal(sent[0].to,adminGroup);
  assert.match(JSON.stringify(sent[0].message),/ภายใน 24 ชั่วโมง/);
  now.setTime(expiresAt);await createNotifications(deps).tick();assert.equal(sent.length,2);assert.match(JSON.stringify(sent[1].message),/หมดอายุแล้ว/);
  assert.equal(store.support.counts().pending,0);
});
test('replacement tokens cancel stale queued expiry warnings',async t=>{
  const store=setup(t);enable(store);const status={source:'settings',updatedAt:1,expiresAt:Date.now()+1000,warning:'expiring'};
  store.support.queueToken(status);let calls=0;
  await store.support.flush({push:async()=>calls++},config.origin,Date.now(),{...status,warning:null,expiresAt:Date.now()+864000000});
  assert.equal(calls,0);assert.equal(store.db.prepare('SELECT state FROM admin_alert_jobs').get().state,'cancelled');
});
test('case workflow supports literal search, filters, paging and optimistic concurrent updates',t=>{
  const store=setup(t);const row=store.support.create({...caseInput(store),question:'SKU_100% ขอดูข้อมูล'});
  assert.equal(store.support.list({query:'100%'}).total,1);assert.equal(store.support.list({query:'no-match'}).total,0);
  store.support.update(row.id,{status:'in_progress',note:'ตรวจสอบอยู่',version:0},'admin');
  assert.throws(()=>store.support.update(row.id,{status:'resolved',note:'stale',version:0},'other-admin'),{status:409});
  store.support.update(row.id,{status:'resolved',note:'ตอบใน LINE แล้ว',version:1},'admin');assert.equal(store.support.list().total,0);
  assert.equal(store.support.list({status:'resolved'}).total,1);assert.throws(()=>store.support.list({status:'injected'}),{status:400});
});
test('historical import runs once and excludes successful answers, generic AI fallbacks, Admin tests and explicit help',t=>{
  const store=setup(t),base={actor:user,groupId,companyId:101,question:'@Shiny คำถามพิเศษ'};
  store.audit({...base,action:'bot.request',outcome:'help'});store.audit({...base,action:'stock.lookup',outcome:'upstream_error'});
  store.audit({...base,actor:'admin',action:'bot.request',outcome:'help'});store.audit({...base,question:'@Shiny help',action:'bot.request',outcome:'help'});
  store.audit({...base,action:'ai.response',outcome:'fallback'});store.support.importHistory('admin');store.support.importHistory('admin');
  assert.equal(store.support.counts().pending,2);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM admin_alert_jobs').get().n,0);
});
test('HTTP queue and Admin destinations require login and CSRF; signed failures persist exactly one case',async t=>{
  const store=setup(t),sent=[];const {app,worker}=await createApp({config,store,shipx:new ShipXClient({demo:true}),line:{reply:async(_token,_text,message)=>sent.push(message)}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await worker.stop();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`,get=(url,options)=>fetch(base+url,options);
  assert.equal((await get('/api/admin/support')).status,401);
  const login=await get('/api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:config.adminPassword})});
  const session=await login.json(),headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:config.origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  assert.equal((await get('/api/admin/admin-alerts',{method:'PUT',headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify({enabled:true,groupId:adminGroup})})).status,403);
  const bot='U'+'f'.repeat(32),event={webhookEventId:'support-webhook',type:'message',timestamp:Date.now(),replyToken:'reply',source:{type:'group',groupId,userId:user},message:{type:'text',text:'@Shiny คำถามที่ไม่รู้จัก',mention:{mentionees:[{index:0,length:6,type:'user',userId:bot,isSelf:true}]}}};
  const body=JSON.stringify({destination:bot,events:[event,event]});
  assert.equal((await get('/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':createHmac('sha256',config.lineSecret).update(body).digest('base64')},body})).status,200);
  await worker.tick();assert.equal(sent.length,1);assert.equal(store.support.counts().pending,1);
  const cases=await (await get('/api/admin/support',{headers})).json(),item=cases.rows[0];
  assert.equal((await get('/api/admin/support/'+item.id,{method:'PUT',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify({status:'resolved',note:'done',version:item.version})})).status,403);
  assert.equal((await get('/api/admin/support/'+item.id,{method:'PUT',headers,body:JSON.stringify({status:'resolved',note:'ตอบแล้ว',version:item.version})})).status,200);
  const attention=await (await get('/api/admin/attention',{headers})).json();assert.equal(attention.counts.pending,0);assert(!JSON.stringify(attention).includes(config.shipxApiKey));
});
test('handoff cards have a clear human-support state and stay within LINE bubble payload size',()=>{
  const reply=handoffReply(123,'Example company');assert.match(reply.text,/SH-000123/);assert.equal(reply.message.contents.header.backgroundColor,'#FFF1CF');
  assert(Buffer.byteLength(JSON.stringify(reply.message.contents))<30000);
});
