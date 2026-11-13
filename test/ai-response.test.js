const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { ShipXClient } = require('../src/shipx');
const { loadAIConfig, DEFAULT_RESPONSES_URL } = require('../src/ai-config');
const { createClassifier } = require('../src/intent');
const { createPresenter, applyPresentation, presentationSpec } = require('../src/ai-response');
const { stockReply, shippingReply, orderReply } = require('../src/replies');
const { answerCommand, createWorker } = require('../src/bot');

const groupId='C'+'1'.repeat(32), response=data=>Response.json(data);
function draft(reply,type,extra={}) {
  const spec=presentationSpec(reply,type);
  return { title:spec.titles[0],summaryTemplate:spec.templates[0],density:'compact',
    sectionOrder:spec.sections.map(s=>s.id).reverse(),rowOrder:spec.sections.flatMap(s=>s.rows).reverse(),...extra };
}
const completion=plan=>response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]});
function setup(t) { const store=new Store(':memory:');store.seedDemo();t.after(()=>store.close());return store; }

test('classifier and presenter use the configured Responses gateway and bearer key', async () => {
  const config = loadAIConfig({
    OPENAI_BASE_URL: ' https://gateway.example.test/v1/ ', OPENAI_API_KEY: 'mock-key',
    OPENAI_MODEL: 'gateway-tools', OPENAI_RESPONSE_MODEL: 'gateway-json',
  });
  const reply = stockReply({ sku: 'EXAMPLE', name: 'Product', ready: 12 });
  const calls = [];
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://gateway.example.test/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer mock-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    calls.push(body.model);
    return body.tools ? response({ output: [{ type: 'function_call', name: 'lookup_sellable_stock', arguments: '{}' }] }) : completion(draft(reply, 'stock'));
  };
  assert.equal(await createClassifier(config, fetcher)(['สต๊อก', '[REF_1]'], ['stock']), 'stock');
  assert.equal((await createPresenter(config, fetcher)(reply, { type: 'stock' })).outcome, 'generated');
  assert.deepEqual(calls, ['gateway-tools', 'gateway-json']);
});

test('AI base URL defaults to OpenAI and rejects unsafe values', () => {
  assert.equal(loadAIConfig({}).openaiResponsesUrl, DEFAULT_RESPONSES_URL);
  assert.equal(loadAIConfig({ OPENAI_BASE_URL: 'invalid', OPENAI_API_KEY: 'mock-key' }, true).openaiApiKey, '');
  for (const value of ['gateway.example.test', 'http://gateway.example.test/v1', 'https://user:pass@gateway.example.test/v1',
    'https://gateway.example.test/v1?token=unsafe', 'https://gateway.example.test/v1#hash']) {
    assert.throws(() => loadAIConfig({ OPENAI_BASE_URL: value }), /OPENAI_BASE_URL must be an HTTPS API base URL/);
  }
});

test('second AI call generates a validated card plan without receiving identifiers or upstream free text', async () => {
  const reply=orderReply({orderNo:'PRIVATE-ORDER',status:'กำลังแพ็คสินค้า',carrier:'PRIVATE-CARRIER',tracking:'001239999999'});
  const config={openaiApiKey:'fake',openaiModel:'planner-model',openaiResponseModel:'reply-model'};
  const presenter=createPresenter(config,async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'reply-model');assert.equal(body.store,false);
    assert.equal(body.text.format.strict,true);
    assert.doesNotMatch(options.body,/PRIVATE|001239999999/);
    assert.doesNotMatch(options.body,/กำลังแพ็คสินค้า/);
    return completion(draft(reply,'order'));
  });
  const result=await presenter(reply,{type:'order'});
  assert.equal(result.outcome,'generated');
  assert.match(result.reply.text,/เช็กให้แล้วครับ/);
  assert.match(result.reply.text,/กำลังแพ็คสินค้า/);
  for(const field of ['PRIVATE-ORDER','PRIVATE-CARRIER','001239999999']) assert(JSON.stringify(result.reply.message).includes(field));
  assert.doesNotMatch(result.reply.text,/\{\{/);
});

test('AI can reorder fields but cannot change counts, remove rows, add a URL or fabricate a summary', async () => {
  const reply=stockReply({sku:'SKU001',name:'Product',ready:128});
  const good=draft(reply,'stock');
  const result=applyPresentation(reply,'stock',good);
  assert.match(result.text,/128/);assert.match(result.text,/SKU001/);assert.match(result.text,/Product/);
  for(const bad of [
    {...good,summaryTemplate:'พร้อมขาย 999999 ชิ้น'},
    {...good,rowOrder:[]},
    {...good,rowOrder:[good.rowOrder[0],good.rowOrder[0]]},
    {...good,sectionOrder:[]},
    {...good,title:'ส่งของแล้วทุกออเดอร์'},
    {...good,url:'https://evil.test'},
  ]) assert.throws(()=>applyPresentation(reply,'stock',bad),/Invalid AI presentation/);
});

test('refusals, timeouts, invalid plans, non-completed responses and HTTP failures fall back to the verified reply', async () => {
  const reply=stockReply({sku:'SKU001',ready:0});
  for(const fetcher of [
    async()=>{throw Error('network timeout')},
    async()=>new Response('',{status:401}),
    async()=>response({output:[{type:'message',content:[{type:'refusal'}]}]}),
    async()=>completion(draft(reply,'stock',{summaryTemplate:'ผิด 999'})),
    async()=>response({status:'incomplete',output:[]}),
  ]) {
    const result=await createPresenter({openaiApiKey:'fake',openaiModel:'model'},fetcher)(reply,{type:'stock'});
    assert.equal(result.outcome,'fallback');assert.equal(result.reply,reply);
  }
  assert.equal(createPresenter({demo:true,openaiApiKey:'fake'}),null);
  assert.equal(createPresenter({openaiApiKey:'fake',aiResponseEnabled:false}),null);
});

test('unknown-status warning survives presentation and calculations stay exact', async () => {
  const report=await new ShipXClient({demo:true}).shippingProgress(101);
  const reply=shippingReply(report);
  const result=applyPresentation(reply,'shipping',draft(reply,'shipping'));
  assert.match(result.text,/ต้องตรวจสถานะเพิ่มเติม/);
  assert.match(result.text,/ยังตรวจสถานะไม่ได้: 1/);
  assert.match(result.text,/แพ็คเสร็จแล้ว: 4/);
  assert.match(result.text,/ต้องส่งทั้งหมด: 8/);
  assert.match(result.text,/50%/);
});

test('worker runs AI command -> scoped API -> AI presentation -> LINE, and leaves no private AI payload', async t => {
  const store=setup(t),sequence=[];
  const expected=orderReply({orderNo:'SO001',status:'กำลังแพ็คสินค้า'});
  const classify=createClassifier({openaiApiKey:'fake',openaiModel:'model'},async()=>{sequence.push('ai-command');return response({output:[{type:'function_call',name:'lookup_order',arguments:'{}'}]})});
  const present=createPresenter({openaiApiKey:'fake',openaiModel:'model'},async(_,options)=>{
    sequence.push('ai-presentation');assert.doesNotMatch(options.body,/SO001/);
    return completion(draft(expected,'order'));
  });
  const worker=createWorker({config:{},store,classify,present,
    shipx:{findOrder:async(company,reference)=>{
      sequence.push('shipx');assert.equal(company,101);assert.equal(reference,'SO001');
      return {outcome:'found',order:{orderNo:'SO001',status:'กำลังแพ็คสินค้า'}};
    }},
    line:{reply:async(token,text,message)=>{sequence.push('line');assert.equal(token,'reply');assert.match(text,/เช็กให้แล้วครับ/);assert.equal(message.type,'flex');}},
  });
  store.enqueue([{webhookEventId:'ai-two-stage',timestamp:Date.now(),type:'message',source:{type:'group',groupId},command:'order SO001',replyToken:'reply'}]);
  await worker.tick();
  assert.deepEqual(sequence,['ai-command','shipx','ai-presentation','line']);
  assert(store.audits().some(a=>a.action==='ai.response'&&a.outcome==='generated'));
  assert.equal(store.db.prepare('SELECT payload FROM jobs WHERE id=?').get('ai-two-stage').payload,null);
});

test('permission change during the second AI call suppresses all former-company data', async t => {
  const store=setup(t);
  const reply=stockReply({sku:'PRIVATE-SKU',name:'PRIVATE-NAME',ready:128});
  const present=createPresenter({openaiApiKey:'fake',openaiModel:'model'},async()=>{
    const g=store.group(groupId);
    store.mapGroup(groupId,{companyId:202,active:true,orderEnabled:true,stockEnabled:true,name:g.name,revision:g.revision},'admin');
    return completion(draft(reply,'stock'));
  });
  const result=await answerCommand({store,groupId,text:'stock SKU001',present,shipx:{findStock:async()=>({outcome:'found',stock:{sku:'PRIVATE-SKU',name:'PRIVATE-NAME',ready:128}})}});
  assert.match(result.text,/เปลี่ยนระหว่างสอบถาม/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|128/);
});
