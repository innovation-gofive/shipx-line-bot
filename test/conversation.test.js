const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { answerCommand } = require('../src/bot');
const { ShipXClient } = require('../src/shipx');
const { shipxAuth } = require('../src/shipx-auth');
const { loadConfig } = require('../src/config');

const groupId = 'C' + '1'.repeat(32), secondGroupId = 'C' + '2'.repeat(32);
const userId = 'U' + 'a'.repeat(32), otherUser = 'U' + 'b'.repeat(32);

function setup(t) {
  const store = new Store(':memory:');
  store.seedDemo();
  t.after(() => store.close());
  const ask = (text, extra) => answerCommand({ store, shipx: {}, groupId, actor: userId, text, ...extra });
  return { store, ask };
}

test('named user memory is isolated by LINE user and company, and cleared on request', async t => {
  const { store, ask } = setup(t);
  assert.match((await ask('ผมชื่อรอนนะครับ')).text, /คุณรอน/);
  assert.match((await ask('ผมชื่ออะไร')).text, /คุณชื่อรอน/);
  assert.match((await ask('จำชื่อผมได้ไหม')).text, /คุณชื่อรอน/);
  assert.match((await ask('สวัสดีครับ')).text, /คุณรอน/);
  assert.match((await ask('จำชื่อผมได้ไหม', { actor: otherUser })).text, /ยังไม่มีชื่อ/);
  store.mapGroup(secondGroupId, { companyId: 202, active: true, orderEnabled: true, name: 'Second', revision: store.group(secondGroupId).revision }, 'admin');
  assert.match((await ask('ผมชื่ออะไร', { groupId: secondGroupId })).text, /ยังไม่มีชื่อ/);
  await ask('ลืมชื่อผมด้วย');
  assert.match((await ask('ผมชื่ออะไร')).text, /ยังไม่มีชื่อ/);
  await ask('เรียกผมว่ารอน');
  store.mapGroup(groupId, { companyId: 101, active: false, orderEnabled: true, name: 'First', revision: store.group(groupId).revision }, 'admin');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM user_profiles').get().n, 0);
});

test('persona handles identity, age and permitted capabilities without ShipX or AI calls', async t => {
  const { store, ask } = setup(t);
  const classify = async () => assert.fail('conversation called AI');
  assert.match((await ask('คุณชื่ออะไร', { classify })).text, /Shiny ค่ะ/);
  assert.doesNotMatch((await ask('สวัสดีครับ', { classify })).text, /ครับ|ผม/);
  assert.match((await ask('อายุเท่าไหร่ครับ', { classify })).text, /ไม่มีอายุแบบคน/);
  const group = store.group(groupId);
  store.mapGroup(groupId, { companyId: 101, active: true, orderEnabled: true, name: 'Order only', revision: group.revision }, 'admin');
  const reply = await ask('ตอบอะไรได้บ้าง', { classify });
  assert.match(reply.text, /สถานะออเดอร์/);
  assert.doesNotMatch(reply.text, /สต๊อก|ยอดขาย/);
});

test('log records the customer question while the API receives only the bound reference', async t => {
  const { store, ask } = setup(t);
  const question = '@ShipX Bot เช็กสต๊อก 0000123 ให้หน่อย';
  await ask('เช็กสต๊อก 0000123 ให้หน่อย', { question, shipx: {
    findStock: async (companyId, reference) => {
      assert.equal(companyId, 101);
      assert.equal(reference, '0000123');
      return { outcome: 'not_found' };
    },
  } });
  const audit = store.audits()[0];
  assert.equal(audit.question, question);
  assert.equal(audit.reference, '0000123');
  assert.equal(audit.actor, userId);
});

test('API key mode and auto mode exclude a stale JWT while explicit both mode retains it', async () => {
  const auth = { shipxApiKey: 'machine-key', shipxBearer: 'expired-jwt' };
  assert.deepEqual(shipxAuth(auth), { mode: 'api-key', headers: { 'X-API-Key': 'machine-key' } });
  assert.deepEqual(shipxAuth({ ...auth, shipxAuthMode: 'api-key' }).headers, { 'X-API-Key': 'machine-key' });
  assert.deepEqual(shipxAuth({ ...auth, shipxAuthMode: 'both' }).headers, { 'X-API-Key': 'machine-key', Authorization: 'Bearer expired-jwt' });
  const client = new ShipXClient({ ...auth, shipxBaseUrl: 'https://example.test' }, async (_url, options) => {
    assert.equal(options.headers['X-API-Key'], 'machine-key');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ data: { companies: [] } });
  });
  await client.companies();
  const env = { APP_URL: 'https://bot.example.test', ADMIN_PASSWORD: 'a-long-test-password', LINE_CHANNEL_SECRET: 'mock', LINE_CHANNEL_ACCESS_TOKEN: 'mock',
    SHIPX_BASE_URL: 'https://shipx.example.test', SHIPX_AUTH_MODE: 'api-key' };
  assert.equal(loadConfig(env).shipxAuthMode, 'api-key'); // Admin can configure a token after startup.
  assert.throws(() => shipxAuth({ shipxAuthMode: 'api-key' }), /SHIPX_API_KEY is required/);
  assert.equal(loadConfig({ ...env, SHIPX_API_KEY: 'machine-key' }).shipxAuthMode, 'api-key');
});
