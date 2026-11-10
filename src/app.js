const express = require('express');
const path = require('node:path');
const { randomBytes, createHash, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { verifySignature, addressedCommand } = require('./line');
const { createWorker, answerCommand, GROUP_ID } = require('./bot');
const { createClassifier } = require('./intent');
const { createPresenter } = require('./ai-response');
const { stockReply } = require('./replies');
const { createNotifications } = require('./notifications');
const { DEFAULT_NOTIFICATION_TIME, NOTIFICATION_TIME_ZONE } = require('./notification-time');
const { isCompanyId, COMPANY_ENDPOINT, SEARCH_ENDPOINT, STOCK_ENDPOINT, DAILY_ENDPOINT, SALES_ENDPOINT, SHIPPING_ENDPOINT } = require('./shipx');
const deriveKey = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function limiter(max, windowMs) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
    const key = req.ip;
    if (!buckets.has(key) && buckets.size >= 10000) return res.status(429).json({ error: 'คำขอมากเกินไป กรุณารอสักครู่' });
    const value = buckets.get(key) || { until: now + windowMs, count: 0 };
    buckets.set(key, value);
    if (++value.count > max) {
      res.set('Retry-After', String(Math.ceil((value.until - now) / 1000)));
      return res.status(429).json({ error: 'คำขอมากเกินไป กรุณารอสักครู่' });
    }
    next();
  };
}
async function createApp({ config, store, shipx, line }) {
  const app = express(), salt = randomBytes(32), passwordKey = await deriveKey(config.adminPassword, salt, 64);
  const classify = createClassifier(config), present = createPresenter(config);
  const worker = createWorker({ config, store, shipx, line, classify, present });
  const notifications = createNotifications({ config, store, shipx, line, present });
  store.db.exec('DELETE FROM sessions');
  app.disable('x-powered-by');
  app.set('trust proxy', config.production ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/healthz', (req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (config.demo) return res.status(503).json({ error: 'Webhook is disabled in demo mode' });
    if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get('x-line-signature'), config.lineSecret)) return res.sendStatus(401);
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
    if (!body || !Array.isArray(body.events) || body.events.length > 100) return res.sendStatus(400);
    const events = [];
    for (const event of body.events) {
      if (!event || typeof event !== 'object') return res.sendStatus(400);
      if (event.source?.type !== 'group') continue;
      if (!GROUP_ID.test(event.source.groupId || '') || typeof event.webhookEventId !== 'string' || event.webhookEventId.length > 128 || !event.webhookEventId || !Number.isSafeInteger(event.timestamp)) return res.sendStatus(400);
      if (!['join', 'leave', 'message'].includes(event.type)) continue;
      if (event.timestamp < Date.now() - 20 * 60000 || event.timestamp > Date.now() + 60000) continue;
      // Persist only fields needed by the worker, then redact the payload on completion.
      const command = event.type === 'message' && event.mode !== 'standby' ? addressedCommand(event.message, body.destination) : null;
      events.push({
        webhookEventId: event.webhookEventId, timestamp: event.timestamp, type: event.type,
        source: { type: 'group', groupId: event.source.groupId, userId: typeof event.source.userId === 'string' ? event.source.userId.slice(0, 80) : null },
        replyToken: command !== null && typeof event.replyToken === 'string' ? event.replyToken.slice(0, 256) : null,
        command,
      });
    }
    // Apply lifecycle changes immediately, so a leave event revokes an in-flight lookup.
    store.transaction(() => {
      for (const event of events) {
        if (store.db.prepare('SELECT id FROM jobs WHERE id=?').get(event.webhookEventId)) continue;
        store.discover(event.source.groupId, event.timestamp, event.type === 'leave');
        if (event.type !== 'message' || event.replyToken) {
          store.db.prepare('INSERT INTO jobs(id,payload,created_at) VALUES(?,?,?)').run(event.webhookEventId, JSON.stringify(event), Date.now());
        }
      }
    });
    res.sendStatus(200);
  });
  app.use('/api', express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/public', (req, res) => res.json({ demo: config.demo }));
  function requireOrigin(req, res, next) {
    if (req.get('origin') !== config.origin) return res.status(403).json({ error: 'Origin ไม่ถูกต้อง กรุณาเปิดผ่าน APP_URL ที่ตั้งไว้' });
    next();
  }
  function cookieToken(req) {
    const match = /(?:^|;\s*)shipx_session=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie') || '');
    return match?.[1];
  }
  function requireSession(req, res, next) {
    const token = cookieToken(req);
    const session = token && store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    if (!session) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    req.session = session;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('origin') !== config.origin || req.get('x-csrf-token') !== session.csrf) return res.status(403).json({ error: 'กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง' });
    }
    next();
  }
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/', maxAge: 8 * 3600000 };
  app.post('/api/login', requireOrigin, limiter(10, 15 * 60000), async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 512 || username.length > 100) throw fail('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401);
    const actual = await deriveKey(password, salt, 64);
    if (!timingSafeEqual(passwordKey, actual) || hash(username) !== hash(config.adminUsername)) {
      store.audit({ action: 'admin.login', outcome: 'denied' });
      throw fail('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    const old = cookieToken(req);
    if (old) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(old));
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    store.db.prepare('INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)').run(hash(token), csrf, Date.now() + 8 * 3600000);
    store.audit({ actor: config.adminUsername, action: 'admin.login', outcome: 'success' });
    res.cookie('shipx_session', token, cookieOptions).json({ csrf, username: config.adminUsername });
  });
  app.use('/api/admin', requireSession, limiter(300, 60000));
  app.get('/api/admin/session', (req, res) => res.json({ csrf: req.session.csrf, username: config.adminUsername }));
  app.post('/api/admin/logout', (req, res) => {
    store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.clearCookie('shipx_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  app.get('/api/admin/dashboard', (req, res) => res.json({ stats: store.stats(), groups: store.groups(), companies: store.companies(), audit: store.audits() }));
  app.get('/api/admin/settings', (req, res) => res.json({
    demo: config.demo, appUrl: config.origin, webhookUrl: config.origin + '/webhook',
    lineConfigured: !!(config.lineSecret && config.lineToken), shipxConfigured: !!config.shipxBaseUrl && !!(config.shipxApiKey || config.shipxBearer),
    shipxBaseUrl: config.shipxBaseUrl, apiKeyConfigured: !!config.shipxApiKey, bearerConfigured: !!config.shipxBearer,
    aiConfigured: !!classify, aiResponseConfigured: !!present,
    aiModel: config.openaiModel || 'gpt-4o-mini', aiResponseModel: config.openaiResponseModel || config.openaiModel || 'gpt-4o-mini',
    searchEndpoint: SEARCH_ENDPOINT, companyEndpoint: COMPANY_ENDPOINT,
    stockEndpoint: STOCK_ENDPOINT, overviewEndpoint: DAILY_ENDPOINT, salesEndpoint: SALES_ENDPOINT,
    shippingEndpoint: SHIPPING_ENDPOINT, shippingDateConfirmed: config.demo || !!config.shippingDateIsDueDate,
    notificationTime: DEFAULT_NOTIFICATION_TIME, notificationTimeZone: NOTIFICATION_TIME_ZONE,
  }));
  app.post('/api/admin/ai/test', limiter(3, 60000), async (req, res) => {
    if (config.demo) throw fail('Demo ไม่เรียก AI จริง ใช้คำสั่งทดสอบ AI ตามคู่มือหรือเปิดในระบบที่ตั้งค่าคีย์แล้ว');
    if (!classify) throw fail('กรุณาตั้ง OPENAI_API_KEY ใน Coolify แล้ว redeploy ก่อน');
    let planner = false, presenter = null;
    try { planner = await classify(['วันนี้', 'ต้อง', 'ส่ง', 'กี่', 'ออเดอร์', 'แพ็ค', 'แล้ว', 'เท่าไหร่'], ['shipping']) === 'shipping'; } catch {}
    if (present) {
      const result = await present(stockReply({ sku: 'EXAMPLE', name: 'สินค้าตัวอย่าง', ready: 12 }), { type: 'stock' });
      presenter = result.outcome === 'generated';
    }
    store.audit({ actor: config.adminUsername, action: 'ai.test', outcome: planner && presenter !== false ? 'success' : 'failed' });
    res.json({ planner, presenter });
  });
  app.post('/api/admin/companies/sync', limiter(5, 60000), async (req, res) => {
    let companies;
    try { companies = await shipx.companies(); } catch { throw fail('ดึงรายชื่อบริษัทไม่สำเร็จ กรุณาตรวจ URL และสิทธิ์ API ใน Coolify', 502); }
    store.saveCompanies(companies);
    store.audit({ actor: config.adminUsername, action: 'companies.sync', outcome: 'success' });
    res.json({ companies });
  });
  app.put('/api/admin/groups/:id', (req, res) => {
    const b = req.body || {}, keys = ['companyId', 'active', 'orderEnabled', 'stockEnabled', 'reportEnabled', 'alertsEnabled', 'alertsTime', 'name', 'revision'];
    if (!GROUP_ID.test(req.params.id) || Object.keys(b).some(k => !keys.includes(k)) ||
      !(b.companyId === null || isCompanyId(b.companyId)) || typeof b.active !== 'boolean' || typeof b.orderEnabled !== 'boolean' ||
      ['stockEnabled', 'reportEnabled', 'alertsEnabled'].some(key => Object.hasOwn(b, key) && typeof b[key] !== 'boolean') ||
      typeof b.name !== 'string' || b.name.length > 120 || !Number.isSafeInteger(b.revision) || b.revision < 0) throw fail('ข้อมูลการผูกกลุ่มไม่ถูกต้อง');
    res.json({ group: store.mapGroup(req.params.id, b, config.adminUsername) });
  });
  app.post(['/api/admin/test-command', '/api/admin/test-order'], limiter(20, 60000), async (req, res) => {
    const b = req.body || {};
    if (Object.keys(b).some(k => !['groupId', 'text'].includes(k)) || !GROUP_ID.test(b.groupId || '') || typeof b.text !== 'string' || b.text.length > 250) throw fail('เลือกกลุ่มและใส่คำสั่งให้ถูกต้อง');
    const result = await answerCommand({ store, shipx, groupId: b.groupId, text: b.text, actor: config.adminUsername, classify, present });
    res.json({ reply: result.text });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
  app.use((req, res) => res.sendStatus(404));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error('Request failed:', req.method, req.path, 'status', status);
    res.status(status).json({ error: status < 500 ? error.message : 'ระบบไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' });
  });
  const cleanup = setInterval(() => store.cleanup(), 3600000);
  cleanup.unref();
  const originalStop = worker.stop, originalStart = worker.start;
  worker.start = () => { originalStart(); notifications.start(); };
  worker.stop = async () => { clearInterval(cleanup); await Promise.all([originalStop(), notifications.stop()]); };
  return { app, worker };
}
module.exports = { createApp };
