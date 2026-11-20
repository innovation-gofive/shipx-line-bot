const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmdirSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { ShipXTokenStore, tokenSettings } = require('../src/shipx-token');
const { ShipXClient } = require('../src/shipx');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

function fixture(t, extra = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shipx-token-test-'));
  const config = {
    origin: 'http://localhost:3000', databasePath: path.join(directory, 'shipx.sqlite'),
    shipxBaseUrl: 'https://api.example.test', shipxAuthMode: 'bearer',
    adminUsername: 'admin', adminPassword: 'test-password-long-enough',
    lineSecret: 'test-line-secret', lineToken: 'test-line-token', ...extra,
  };
  const f = { config, directory, now: Date.parse('2026-11-20T10:00:00+07:00') };
  f.store = new Store(config.databasePath);
  f.tokens = new ShipXTokenStore(config, f.store, { clock: () => f.now });
  t.after(() => {
    f.store.close();
    for (const name of ['shipx.sqlite', 'shipx.sqlite-wal', 'shipx.sqlite-shm', 'shipx-token.key']) {
      const file = path.join(directory, name);
      if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(directory);
  });
  return f;
}
const jwt = exp => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, name: 'PRIVATE-CLAIM' })).toString('base64url')}.test-signature`;
const companies = () => Response.json({ data: { companies: [{ companyId: 14, companyName: 'Own company' }] } });

test('app starts without ShipX credentials so an admin can configure them in settings', async () => {
  const env = {
    APP_URL: 'https://bot.example.test', ADMIN_PASSWORD: 'test-password-long-enough',
    LINE_CHANNEL_SECRET: 'test', LINE_CHANNEL_ACCESS_TOKEN: 'test', SHIPX_BASE_URL: 'https://api.example.test',
  };
  for (const mode of ['auto', 'bearer', 'api-key', 'both']) assert.equal(loadConfig({ ...env, SHIPX_AUTH_MODE: mode }).shipxAuthMode, mode);
  let calls = 0;
  const client = new ShipXClient(loadConfig(env), async () => { calls++; return companies(); });
  await assert.rejects(client.companies(), { reason: 'authentication_required' });
  assert.equal(calls, 0);
  assert.throws(() => loadConfig({ ...env, SHIPX_AUTH_MODE: 'oauth' }), /SHIPX_AUTH_MODE/);
});

test('tokens are encrypted, normalized, and available after reopening the database with the same key file', async t => {
  const f = fixture(t), token = jwt(Math.floor(f.now / 1000) + 3600);
  assert.equal(existsSync(f.tokens.keyPath), false);
  const status = f.tokens.save(` Bearer ${token} `, 'admin');
  assert.equal(status.configured, true);
  assert.equal(status.expired, false);
  assert.equal(f.tokens.token(), token);
  const key = readFileSync(f.tokens.keyPath);
  assert.equal(key.length, 32);
  for (const data of [JSON.stringify(f.tokens.row()), JSON.stringify(status), JSON.stringify(f.store.audits())]) {
    assert(!data.includes(token));
    assert(!data.includes('PRIVATE-CLAIM'));
    assert(!data.includes(key.toString('hex')));
  }
  f.store.close();
  f.store = new Store(f.config.databasePath);
  f.tokens = new ShipXTokenStore(f.config, f.store, { clock: () => f.now });
  assert.equal(f.tokens.token(), token);
  assert.equal(f.tokens.status().source, 'settings');
});

test('a saved token takes effect on the same client immediately and overrides stale environment credentials', async t => {
  const f = fixture(t, { shipxAuthMode: 'auto', shipxApiKey: 'old-api-key', shipxBearer: 'old-bearer-token' });
  const seen = [];
  const client = new ShipXClient(f.config, async (_url, options) => { seen.push(options.headers); return companies(); }, f.tokens);
  await client.companies();
  assert.equal(seen[0]['X-API-Key'], 'old-api-key');
  f.tokens.save('Bearer replacement-token-one', 'admin');
  await client.companies();
  assert.equal(seen[1].Authorization, 'Bearer replacement-token-one');
  assert.equal(seen[1]['X-API-Key'], undefined);
  f.tokens.save('replacement-token-two', 'admin');
  await client.companies();
  assert.equal(seen[2].Authorization, 'Bearer replacement-token-two');
  assert.equal(tokenSettings(f.config, f.tokens).mode, 'bearer');
});

test('invalid input cannot overwrite a working token or create token-bearing audit entries', t => {
  const f = fixture(t);
  f.tokens.save('working-token', 'admin');
  for (const value of ['', 'Bearer ', null, {}, 'a b', 'token\r\nX-Evil: injected', 'x'.repeat(12101)]) {
    assert.throws(() => f.tokens.save(value, 'admin'), { status: 400 });
  }
  assert.equal(f.tokens.token(), 'working-token');
  assert.equal(f.store.audits().filter(row => row.action === 'shipx.token.update').length, 1);
});

test('expiry hints support JWT and opaque tokens without treating unverified claims as authorization', t => {
  const f = fixture(t);
  const expired = jwt(Math.floor(f.now / 1000) - 60);
  assert.equal(f.tokens.save(expired, 'admin').expired, true);
  assert.equal(f.tokens.token(), expired);
  const opaque = f.tokens.save('opaque-token', 'admin');
  assert.equal(opaque.expiresAt, null);
  assert.equal(opaque.expired, false);
});

test('missing or damaged key material fails closed and a new token can recover a lost key', async t => {
  const f = fixture(t, { shipxBearer: 'stale-environment-token' });
  f.tokens.save('stored-token', 'admin');
  let calls = 0;
  const client = new ShipXClient(f.config, async () => { calls++; return companies(); }, f.tokens);
  unlinkSync(f.tokens.keyPath);
  assert.equal(tokenSettings(f.config, f.tokens).configured, false);
  await assert.rejects(client.companies(), { reason: 'token_storage_unreadable' });
  assert.equal(calls, 0);
  f.tokens.save('new-token-after-key-loss', 'admin');
  await client.companies();
  assert.equal(calls, 1);
  writeFileSync(f.tokens.keyPath, Buffer.alloc(32));
  assert.equal(f.tokens.status().error, 'token_storage_unreadable');
  await assert.rejects(client.companies(), { reason: 'token_storage_unreadable' });
  assert.equal(calls, 1);
});

test('API 401 reports the failure once and accepts a replacement through settings without recreating the client', async t => {
  const f = fixture(t);
  f.tokens.save('expired-token', 'admin');
  let calls = 0;
  const client = new ShipXClient(f.config, async (_url, options) => {
    calls++;
    return options.headers.Authorization === 'Bearer fresh-token' ? companies() : new Response('', { status: 401 });
  }, f.tokens);
  await assert.rejects(client.companies(), { statusCode: 401 });
  assert.equal(calls, 1);
  f.tokens.save('fresh-token', 'admin');
  assert.equal((await client.companies())[0].id, 14);
  assert.equal(calls, 2);
});

test('HTTP settings enforce admin/CSRF, return metadata only, and apply updates to subsequent API requests', async t => {
  const f = fixture(t);
  let accepted = 'first-token', calls = 0;
  const shipx = new ShipXClient(f.config, async (_url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${accepted}`);
    return companies();
  }, f.tokens);
  const { app, worker } = await createApp({ config: f.config, store: f.store, shipx, line: {}, tokens: f.tokens });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await worker.stop(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (endpoint, options = {}) => fetch(base + endpoint, options);
  const endpoint = '/api/admin/shipx/token';
  assert.equal((await request(endpoint, { method: 'PUT' })).status, 401);
  const logged = await request('/api/login', {
    method: 'POST', headers: { Origin: f.config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: f.config.adminUsername, password: f.config.adminPassword }),
  });
  const session = await logged.json(), cookie = logged.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: f.config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  const put = body => request(endpoint, { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal((await request(endpoint, { method: 'PUT', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: '{"token":"not-saved"}' })).status, 403);
  assert.equal((await put({ token: 'wrong', companyId: 999 })).status, 400);
  assert.equal((await put({ token: 'bad\r\nheader' })).status, 400);
  const saved = await put({ token: 'Bearer first-token' });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal((await saved.json()).tokenStatus.source, 'settings');
  assert.equal((await request('/api/admin/companies/sync', { method: 'POST', headers, body: '{}' })).status, 200);
  accepted = 'second-token';
  assert.equal((await put({ token: accepted })).status, 200);
  assert.equal((await request('/api/admin/companies/sync', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(calls, 2);
  const settings = await (await request('/api/admin/settings', { headers: { Cookie: cookie } })).json();
  assert.equal(settings.shipxConfigured, true);
  assert.equal(settings.shipxAuthMode, 'bearer');
  assert.equal(settings.shipxTokenStatus.source, 'settings');
  for (const value of ['first-token', 'second-token']) {
    assert(!JSON.stringify(settings).includes(value));
    assert(!JSON.stringify(f.store.audits()).includes(value));
  }
});
