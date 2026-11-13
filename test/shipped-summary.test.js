const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { ShipXClient, SHIPPING_ENDPOINT, SHIPPING_HISTORY_ENDPOINT } = require('../src/shipx');
const { createNotifications } = require('../src/notifications');
const { createApp } = require('../src/app');
const { dailyShippedReply } = require('../src/replies');

const groupId = 'C' + '1'.repeat(32), secondGroupId = 'C' + '2'.repeat(32);
const cutoff = new Date('2026-11-11T18:00:00+07:00');
const config = { shipxBaseUrl: 'https://example.test', origin: 'https://bot.example.test', shippingDateIsDueDate: true };
const batch = (id, items, overrides = {}) => ({
  summaryPlatformBatchId: id, companyId: 101, dateCreated: '2026-11-10T17:30:00Z', platform: 'Shopee', items, ...overrides,
});
const scan = (orderId, overrides = {}) => ({ orderId, previousStatus: 2003, newStatus: 2004, isCancelled: false, ...overrides });
const response = data => Response.json({ data });

test('counts completed outbound orders once, separates Express and B2B, and uses the Bangkok cutoff', async () => {
  const batches = [
    batch(10, [scan(1, { newStatus: 2003, packageNewStatus: 'Shipped' }), scan(2), scan(3, { isCancelled: true }), scan(4, { platform: 'Lazada' })]),
    batch(11, null),
    batch(12, [scan(9)], { dateCreated: '2026-11-11T18:00:00.001+07:00' }),
  ];
  const fetched = [];
  const client = new ShipXClient(config, async (url, options) => {
    assert.equal(options.method, 'GET');
    if (url.pathname === SHIPPING_HISTORY_ENDPOINT) {
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        companyId: '101', fromDate: '2026-11-11T00:00:00+07:00', toDate: '2026-11-11T11:00:00.000Z',
      });
      return response({ batches });
    }
    if (url.pathname === `${SHIPPING_HISTORY_ENDPOINT}/11`) return response(batch(11, [
      scan(2), scan(5, { platform: 'TikTok Shop' }), scan(6, { platform: 'Manual' }), scan(7), scan(8),
    ]));
    const orderId = Number(url.pathname.split('/').at(-2));
    fetched.push(orderId);
    const orderType = orderId === 8 ? null : Number(orderId === 2);
    return response({ orderId, companyId: 101, expressDelivery: [2, 7].includes(orderId), orderType, customerPhone: 'SECRET' });
  });
  const report = await client.dailyShippedOrders(101, cutoff);
  assert.deepEqual(fetched.sort(), [2, 4, 5, 6, 7, 8]);
  assert.deepEqual(report, { date: '2026-11-11', shopee: 0, lazada: 1, tiktok: 1, express: 1, b2b: 1, b2bExpress: 1, other: 1, unknownType: 1, total: 6 });
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('shipping summaries fail closed when ShipX cannot verify batch or order detail scope', async () => {
  const cases = [
    { list: batch(10, [], { companyId: 202 }) },
    { list: batch(10, [], { dateCreated: '2026-11-10T16:59:59Z' }) },
    { list: batch(10, null), detail: batch(10, [scan(1)], { companyId: 202 }) },
    { list: batch(10, null), detail: batch(10, [scan(1)], { dateCreated: '2026-11-11T11:01:00Z' }) },
    { list: batch(10, [scan(1)]), order: { orderId: 1, companyId: 202, expressDelivery: true } },
    { list: batch(10, [scan(1)]), order: { orderId: 2, companyId: 101, expressDelivery: true } },
    { list: batch(10, [scan(1)]), order: { orderId: 1, companyId: 101, expressDelivery: 'true' } },
  ];
  for (const { list, detail, order } of cases) {
    const client = new ShipXClient(config, async url => {
      if (url.pathname === SHIPPING_HISTORY_ENDPOINT) return response({ batches: [list] });
      return response(url.pathname.startsWith(SHIPPING_HISTORY_ENDPOINT) ? detail : order);
    });
    await assert.rejects(client.dailyShippedOrders(101, cutoff), /not verified/);
  }
});

test('LINE Flex includes the company, channels, B2B and highlighted total, even with a zero channel', async () => {
  const report = await new ShipXClient({ demo: true }).dailyShippedOrders(101, cutoff);
  const { message } = dailyShippedReply(report, 'Ikigai', '18:00');
  assert.equal(message.type, 'flex');
  assert.match(message.altText, /11\/11\/2026.*Ikigai.*352/);
  const [company, channels, total, note] = message.contents.body.contents;
  assert.equal(company.text, 'Ikigai');
  assert.deepEqual(channels.contents.filter(row => row.type === 'box').map(row => row.contents.map(cell => cell.text)), [
    ['Shopee', '120'], ['Lazada', '13'], ['TikTok', '215'], ['Express (B2C)', '0'], ['B2B', '4'],
  ]);
  assert.match(channels.contents.at(-1).text, /B2B รวม Express 1/);
  assert.notEqual(total.backgroundColor, channels.backgroundColor);
  const [totalLabel, totalValue] = total.contents[0].contents;
  assert.equal(totalLabel.text, 'Total');
  assert.equal(totalValue.text, '352');
  assert.equal(totalValue.size, 'xxl');
  assert.equal(totalValue.weight, 'bold');
  assert.match(note.text, /18:00 น\./);
});

test('follow-up lists due orders by pickup stage and order type across all pages', async () => {
  const order = (orderId, status, orderType) => ({
    orderId, companyId: 101, shippingDate: '2026-11-11T20:00:00+07:00', orderDocumentNo: `SO${orderId}`,
    status, orderType, customerPhone: 'SECRET',
  });
  let requests = 0;
  const client = new ShipXClient(config, async (url, options) => {
    assert.equal(url.pathname, SHIPPING_ENDPOINT);
    const filter = JSON.parse(options.body);
    assert.deepEqual(filter.companyIds, [101]);
    assert.equal(filter.shippingStartDate, '2026-11-11T00:00:00+07:00');
    assert.equal(filter.shippingEndDate, '2026-11-11T23:59:59.999+07:00');
    assert.equal(filter.pageNumber, ++requests);
    return requests === 1 ? response({ data: [order(1, 2004, 1), order(2, 2003, 1), order(3, 2002, 0)], hasMore: true }) :
      response({ data: [order(4, 2004, 0), order(5, 2005, 1), order(6, 3001, 0), order(7, 5001, 1), order(8, 9999, null)], hasMore: false });
  });
  const result = await client.shippingFollowUp(101, cutoff);
  const idsAndStages = groups => groups.map(({ orderNo, stage }) => [orderNo, stage]);
  assert.deepEqual(idsAndStages(result.b2c), [['SO3', 'notReady'], ['SO4', 'pickup']]);
  assert.deepEqual(idsAndStages(result.b2b), [['SO1', 'pickup'], ['SO2', 'notReady']]);
  assert.deepEqual(idsAndStages(result.unknown), [['SO8', 'unknown']]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

function setup(t) {
  const store = new Store(':memory:');
  store.seedDemo();
  t.after(() => store.close());
  const map = (id, extra) => store.mapGroup(id, {
    companyId: id === groupId ? 101 : 202, active: true, orderEnabled: true, reportEnabled: true,
    name: 'Test group', revision: store.group(id).revision, ...extra,
  }, 'admin');
  return { store, map };
}

test('separate group schedules and notification kinds dedupe independently across restarts', async t => {
  const { store, map } = setup(t);
  assert.equal(store.group(groupId).shipping_summary_enabled, 0);
  assert.equal(store.group(groupId).shipping_summary_time, '18:00');
  map(groupId, { alertsEnabled: true, alertsTime: '18:00', shippingSummaryEnabled: true });
  map(secondGroupId, { shippingSummaryEnabled: true, shippingSummaryTime: '18:02' });
  const demo = new ShipXClient({ demo: true });
  let now = new Date(cutoff.getTime() - 1000);
  const sent = [], requests = [];
  const deps = { config, store, clock: () => now, shipx: {
    shippingProgress: (companyId, time) => demo.shippingProgress(companyId, time),
    shippingFollowUp: (companyId, time) => demo.shippingFollowUp(companyId, time),
    dailyShippedOrders: (companyId, time) => { requests.push([companyId, time.toISOString()]); return demo.dailyShippedOrders(companyId, time); },
  }, line: { push: async (id, message, key) => sent.push({ id, message, key }) } };
  let scheduler = createNotifications(deps);
  await scheduler.tick();
  assert.equal(sent.length, 0);
  now = cutoff;
  await scheduler.tick();
  assert.deepEqual(sent.map(item => item.id), [groupId, groupId]);
  assert.notEqual(sent[0].key, sent[1].key);
  assert(sent.some(item => /ต้องติดตาม/.test(item.message.altText)));
  const daily = sent.find(item => Array.isArray(item.message)).message;
  assert.match(daily[0].altText, /ABC Logistics.*352/);
  assert.match(daily[1].altText, /ยังไม่ได้จัดส่ง.*6 ออเดอร์/);
  assert.equal(daily.length, 2);
  const button = daily[1].contents.body.contents.find(component => component.type === 'button');
  assert.match(button.action.uri, /^https:\/\/bot\.example\.test\/shipping-orders#[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(daily), /SO006|SO005/);
  const token = new URL(button.action.uri).hash.slice(1);
  const saved = store.shippingReport(token, cutoff.getTime());
  assert.deepEqual(saved.orders.b2b.map(({ orderNo }) => orderNo), ['SO005', 'SO006']);
  scheduler = createNotifications(deps);
  now = new Date('2026-11-11T18:02:30+07:00');
  await scheduler.tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].id, secondGroupId);
  assert.match(sent[2].message[0].altText, /บริษัท สยามรีเทล จำกัด.*0 ออเดอร์/);
  assert(!sent[2].message[1].contents.body.contents.some(component => component.type === 'button'));
  assert.deepEqual(requests, [[101, cutoff.toISOString()], [202, '2026-11-11T11:02:00.000Z']]);
  assert.equal(store.audits().filter(row => row.action === 'notification.shipping_summary' && row.outcome === 'sent').length, 2);
});

test('summary retries preserve payload and Bangkok report date through midnight without the due-date setting', async t => {
  const { store, map } = setup(t);
  map(groupId, { shippingSummaryEnabled: true, shippingSummaryTime: '23:59' });
  let now = new Date('2026-11-11T23:59:00+07:00'), lookups = 0;
  const sent = [];
  const demo = new ShipXClient({ demo: true });
  const deps = { config: { ...config, shippingDateIsDueDate: false }, store, clock: () => now, shipx: {
    dailyShippedOrders: async (companyId, time) => { lookups++; return demo.dailyShippedOrders(companyId, time); },
  }, line: { push: async (...args) => { sent.push(args); if (sent.length === 1) throw new Error('Timeout'); } } };
  await createNotifications(deps).tick();
  now = new Date('2026-11-12T00:00:01+07:00');
  await createNotifications(deps).tick();
  assert.equal(lookups, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.match(sent[1][1][0].altText, /11\/11\/2026/);
});

test('a group remapped during summary lookup receives no report', async t => {
  const { store, map } = setup(t);
  map(groupId, { shippingSummaryEnabled: true });
  const scheduler = createNotifications({ config, store, clock: () => cutoff, shipx: {
    shippingFollowUp: async (companyId, time) => new ShipXClient({ demo: true }).shippingFollowUp(companyId, time),
    dailyShippedOrders: async () => {
      map(groupId, { companyId: 202, shippingSummaryEnabled: true });
      return new ShipXClient({ demo: true }).dailyShippedOrders(101, cutoff);
    },
  }, line: { push: async () => assert.fail('sent a report for the previous company') } });
  await scheduler.tick();
  assert.equal(store.db.prepare('SELECT state FROM shipping_summary_notifications').get().state, 'cancelled');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM shipping_reports').get().count, 0);
});

test('LINE retry uses the same link and the linked page contains the full group snapshot', async t => {
  const { store, map } = setup(t);
  map(groupId, { shippingSummaryEnabled: true });
  const orders = Array.from({ length: 170 }, (_, index) => ({
    orderNo: `ORDER-${String(index).padStart(4, '0')}-${'X'.repeat(125)}`, stage: 'notReady', status: 'กำลังแพ็คสินค้า',
  }));
  let now = new Date(), lookups = 0;
  const bangkokTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  map(groupId, { shippingSummaryEnabled: true, shippingSummaryTime: bangkokTime });
  const calls = [];
  const deps = { config, store, clock: () => now, shipx: {
    dailyShippedOrders: (companyId, time) => new ShipXClient({ demo: true }).dailyShippedOrders(companyId, time),
    shippingFollowUp: async () => { lookups++; return { b2b: orders, b2c: [], unknown: [] }; },
  }, line: { push: async (id, messages, key) => {
    calls.push({ id, messages, key });
    if (calls.length === 1) throw new Error('Timeout');
  } } };
  await createNotifications(deps).tick();
  now = new Date(now.getTime() + 61000);
  await createNotifications(deps).tick();
  assert.equal(lookups, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].id, groupId);
  assert.equal(calls[0].messages.length, 2);
  assert.doesNotMatch(JSON.stringify(calls[0]), /ORDER-0000/);
  const token = new URL(calls[0].messages[1].contents.body.contents.at(-1).action.uri).hash.slice(1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM shipping_reports').get().count, 1);
  assert.deepEqual(store.shippingReport(token).orders.b2b, orders);
  assert.equal(store.db.prepare('SELECT state FROM shipping_summary_notifications').get().state, 'sent');
});

test('public report requires its valid token and revokes access on expiry, remapping, permission loss or bot departure', async t => {
  const { store, map } = setup(t);
  map(groupId, { shippingSummaryEnabled: true });
  map(secondGroupId, { shippingSummaryEnabled: true });
  const { app, worker } = await createApp({ config: { ...config, adminPassword: 'test-password-long-enough' }, store, shipx: {}, line: {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await worker.stop(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/shipping-orders`;
  const issue = (id, orderNo, at = Date.now()) => store.saveShippingReport(store.group(id), '2026-11-11', '18:00', {
    b2b: [{ orderNo, status: 'พร้อมส่ง', stage: 'pickup' }], b2c: [], unknown: [],
  }, at);
  const open = token => fetch(url, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const first = issue(groupId, 'SO-ABC<script>'), second = issue(secondGroupId, 'SO-OTHER');
  const shell = await fetch(url + '?companyId=202');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('x-robots-tag'), /noindex/);
  assert.doesNotMatch(await shell.text(), /SO-ABC|SO-OTHER/);
  const report = await open(first);
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.equal(report.headers.get('referrer-policy'), 'no-referrer');
  const html = await report.text();
  assert.match(html, /B2B.*<span>1 ออเดอร์/);
  assert.match(html, /SO-ABC&lt;script&gt;/);
  assert.doesNotMatch(html, /SO-OTHER|<script>/);
  assert.match(await (await open(second)).text(), /SO-OTHER/);
  assert.equal((await open()).status, 404);
  assert.equal((await open('f'.repeat(64))).status, 404);
  const expired = issue(groupId, 'EXPIRED', Date.now() - 86400000);
  assert.equal((await open(expired)).status, 404);
  store.cleanup();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM shipping_reports').get().count, 2);
  map(groupId, { shippingSummaryEnabled: false });
  map(groupId, { shippingSummaryEnabled: true });
  assert.equal((await open(first)).status, 404);
  const previousCompany = issue(groupId, 'PREVIOUS-COMPANY');
  map(groupId, { companyId: 202, active: false });
  map(groupId, { shippingSummaryEnabled: true });
  assert.equal((await open(previousCompany)).status, 404);
  store.discover(secondGroupId, Date.now(), true);
  assert.equal((await open(second)).status, 404);
});
