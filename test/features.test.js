const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store');
const { LineClient } = require('../src/line');
const { answerCommand } = require('../src/bot');
const { interpret, createClassifier } = require('../src/intent');
const { ShipXClient, VARIANT_ENDPOINT, STOCK_ENDPOINT, DAILY_ENDPOINT, SALES_ENDPOINT } = require('../src/shipx');

const groupId = 'C' + '1'.repeat(32);
const config = { shipxBaseUrl: 'https://example.test', shipxApiKey: 'fake' };
const now = new Date('2026-11-04T17:05:00Z'); // Just after midnight in Bangkok.
const response = data => Response.json(data);
const product = { variant: { productVariantId: 6, productMasterId: 7, sku: 'SKU001', variantName: 'สินค้า A' }, productMaster: { companyId: 101, productMasterId: 7 } };
const stock = { productVariantId: 6, productMasterId: 7, sku: 'SKU001', currentStock: 0, incoming: 12 };
const products = variants => ({ data: { variants, pageNumber: 1, totalPages: 1 } });
const stockRows = items => ({ items, pagination: { currentPage: 1, totalPages: 1 } });

test('migration preserves V1 mapping and requires opt-in to stock and reports', t => {
  const dir = mkdtempSync(join(tmpdir(), 'shipx-v2-'));
  const file = join(dir, 'previous.sqlite');
  t.after(() => {
    for (const suffix of ['', '-shm', '-wal']) rmSync(file + suffix, { force: true });
    rmdirSync(dir);
  });
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', company_id INTEGER REFERENCES companies(id),
        active INTEGER NOT NULL DEFAULT 0, order_enabled INTEGER NOT NULL DEFAULT 0, bot_present INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO companies VALUES (101,'Company');
    INSERT INTO groups VALUES ('${groupId}','Group',101,1,1,1,5,0,0);`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const store = new Store(file);
    try {
      const g = store.group(groupId);
      assert.deepEqual([g.company_id, g.active, g.order_enabled, g.stock_enabled, g.report_enabled, g.alerts_enabled, g.revision], [101,1,1,0,0,0,5]);
      assert.equal(g.alerts_time, '16:00');
    } finally { store.close(); }
  }
});

test('stock verifies catalog ownership and binds quantities to the exact variant and master', async () => {
  const seen = [];
  const client = new ShipXClient(config, async url => {
    seen.push(url.pathname); assert.deepEqual(url.searchParams.getAll('companyIds'), ['101']);
    if (url.pathname === VARIANT_ENDPOINT) {
      assert.equal(url.searchParams.get('includeProductMaster'), 'true');
      return response(products([product, { ...product, variant: { ...product.variant, productVariantId: 8 }, productMaster: { ...product.productMaster, companyId: 202 } }]));
    }
    assert.equal(url.pathname, STOCK_ENDPOINT);
    return response(stockRows([{ ...stock, productVariantId: 8, currentStock: 900 }, stock]));
  });
  assert.deepEqual(await client.findStock(101, 'sku001'), { outcome:'found', stock:{ sku:'SKU001', name:'สินค้า A', ready:0 } });
  assert.deepEqual(seen, [VARIANT_ENDPOINT, STOCK_ENDPOINT]);
});

test('stock stops before quantities when owner is missing or foreign; wrong master cannot contribute stock', async () => {
  for (const companyId of [undefined, 202, '101']) {
    const client = new ShipXClient(config, async url => {
      assert.equal(url.pathname, VARIANT_ENDPOINT);
      return response(products([{ ...product, productMaster:{ ...product.productMaster, companyId } }]));
    });
    assert.deepEqual(await client.findStock(101, 'SKU001'), { outcome:'not_found' });
  }
  const mismatched = new ShipXClient(config, async url => response(url.pathname === VARIANT_ENDPOINT ? products([product]) : stockRows([{ ...stock, productMasterId:999 }])));
  await assert.rejects(mismatched.findStock(101, 'SKU001'), /not verified/);
  const missing = new ShipXClient(config, async url => response(url.pathname === VARIANT_ENDPOINT ? products([product]) : stockRows([])));
  assert.deepEqual(await missing.findStock(101, 'SKU001'), { outcome:'stock_unavailable' });
});

function daily(url, extra = {}) {
  return {
    appliedCompanyIds: [101], fromDate: url.searchParams.get('fromDate'), toDate: url.searchParams.get('toDate'),
    totalOrders: 16, statusBreakdown: [[1003,2],[2002,3],[2004,4],[3004,1],[5001,1],[5002,2],[9999,2]].map(([statusCode,count])=>({statusCode,count})),
    ...extra,
  };
}

test('daily overview requests each Bangkok date and separates packing, shipping, exceptions and unknowns', async () => {
  const seen = [];
  const client = new ShipXClient(config, async url => {
    assert.equal(url.pathname, DAILY_ENDPOINT); assert.deepEqual(url.searchParams.getAll('companyIds'), ['101']);
    const from = url.searchParams.get('fromDate'), to = url.searchParams.get('toDate');
    seen.push(from); assert.equal(to, from.slice(0,10) + 'T23:59:59.999');
    return response(daily(url));
  });
  const results = await client.orderOverview(101, 3, now);
  assert.deepEqual(seen, ['2026-11-05T00:00:00','2026-11-04T00:00:00','2026-11-03T00:00:00']);
  const { unpacked, awaitingShipment, attention, unknown, complete, pendingStatuses } = results[0];
  assert.deepEqual([unpacked, awaitingShipment, attention, unknown, complete], [5,4,2,3,2]);
  assert(pendingStatuses.some(x=>x.label==='กำลังแพ็คสินค้า' && x.count===3));
  assert(pendingStatuses.every(x=>x.label!=='คืนสินค้าแล้ว'));
});

test('a single unverified day suppresses the entire overview, even when other days pass', async () => {
  for (const extra of [{ appliedCompanyIds:[101,202] },{ appliedCompanyIds:undefined },{ fromDate:'2026-10-01' },{ totalOrders:1 }]) {
    const client = new ShipXClient(config, async url => response(daily(url, url.searchParams.get('fromDate').startsWith('2026-11-04') ? extra : {})));
    await assert.rejects(client.orderOverview(101, 3, now));
  }
});

test('sales report echoes one mapped company and the requested range', async () => {
  let scope = [101];
  const client = new ShipXClient(config, async url => {
    assert.equal(url.pathname, SALES_ENDPOINT); assert.deepEqual(url.searchParams.getAll('companyIds'), ['101']);
    assert.equal(url.searchParams.get('fromDate'),'2026-11-03');
    assert.equal(url.searchParams.get('toDate'),'2026-11-05');
    return response({data:{appliedCompanyIds:scope,fromDate:'2026-11-03',toDate:'2026-11-05',totalOrders:10,totalItems:11,totalRevenue:1200.50}});
  });
  assert.deepEqual(await client.salesReport(101,3,now), {from:'2026-11-03',to:'2026-11-05',totalOrders:10,totalItems:11,totalRevenue:1200.50});
  scope=[202]; await assert.rejects(client.salesReport(101,3,now), /scope/);
});

test('OpenAI receives only redacted vocabulary and cannot supply identifiers, dates, or company scope', async () => {
  const calls=[];
  const classify = createClassifier({openaiApiKey:'fake',openaiModel:'model'}, async (url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const req=JSON.parse(options.body); calls.push(req.input);
    assert.equal(req.store,false); assert.equal(req.tool_choice,'required');assert.equal(req.parallel_tool_calls,false);
    assert(req.tools.every(tool=>tool.strict && tool.parameters.additionalProperties===false));
    return response({output:[{type:'function_call',name:'lookup_order',arguments:'{}'}]});
  });
  assert.deepEqual(await interpret('ช่วยดูให้ทีว่า AB123 ถึงไหนแล้ว คุณสมชาย',classify), {type:'order',reference:'AB123'});
  assert.match(calls[0],/\[REF_1\]/);
  assert.doesNotMatch(calls[0],/AB123|สมชาย/);
  assert.deepEqual(await interpret('สต๊อก SKU001 ให้หน่อย',async()=>{throw new Error('timeout')}), {type:'stock',reference:'SKU001'});
  assert.deepEqual(await interpret('ออเดอร์ SO001 บริษัทอื่น',classify), {type:'help'});
  assert.deepEqual(await interpret('สรุปยอดขายเมื่อวาน',null), {type:'sales',days:1,offset:1});
  assert.deepEqual(await interpret('รายงานยอดขายเดือนนี้',classify), {type:'help'});
  assert.equal(calls.length,2);
});

test('feature opt-in is independent; permission changes during AI or ShipX suppress results', async t => {
  const store=new Store(':memory:'); t.after(()=>store.close()); store.seedDemo();
  const map = (stockEnabled, reportEnabled) => store.mapGroup(groupId,{companyId:101, active:true,orderEnabled:true,stockEnabled,reportEnabled,name:'Test',revision:store.group(groupId).revision},'admin');
  map(false,false);
  let calls=0;
  const shipx={findStock:async()=>{calls++;map(false,true);return {outcome:'found',stock:{sku:'PRIVATE',name:'PRIVATE',ready:14,incoming:0}}},orderOverview:async()=>{calls++;return []}};
  const answer=(text,classify)=>answerCommand({store,shipx,groupId,text,classify});
  assert.match((await answer('stock SKU001')).text,/ยังไม่มีสิทธิ์/);
  assert.match((await answer('สรุปออเดอร์')).text,/ยังไม่มีสิทธิ์/);
  assert.equal(calls,0);
  map(true,true);
  assert.match((await answer('ช่วยดูสต๊อก SKU001',async()=>{map(true,false);return 'stock'})).text,/เปลี่ยนระหว่างสอบถาม/);
  assert.equal(calls,0);
  const result=await answer('stock SKU001');
  assert.doesNotMatch(result.text,/PRIVATE/); assert.equal(result.message,undefined);
  assert.equal(calls,1);
});

test('LINE client submits the Flex card from a scoped report without including other groups', async t => {
  const store=new Store(':memory:'); t.after(()=>store.close()); store.seedDemo();
  const result=await answerCommand({store,shipx:new ShipXClient({demo:true}),groupId,text:'สรุปออเดอร์ค้างวันนี้และย้อนหลัง 2 วัน'});
  assert.match(result.text,/ยังแพ็คไม่เสร็จ/);
  assert.match(result.text,/เมื่อวาน/);
  assert.match(result.text,/สองวันก่อน/);
  const line=new LineClient({lineToken:'fake'},async (url,options)=>{
    assert.equal(url,'https://api.line.me/v2/bot/message/reply');
    const {replyToken,messages}=JSON.parse(options.body);
    assert.equal(replyToken,'test-token');
    assert.equal(messages.length,1);
    assert.equal(messages[0].type,'flex');
    assert.match(messages[0].altText,/ภาพรวมออเดอร์/);
    assert.equal(messages[0].contents.body.contents.filter(x=>x.type==='box').length,3);
    assert(Buffer.byteLength(JSON.stringify(messages[0].contents))<30000);
    return response({});
  });
  await line.reply('test-token',result.text,result.message);
});
