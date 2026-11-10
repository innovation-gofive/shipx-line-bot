const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { DEFAULT_NOTIFICATION_TIME, isNotificationTime } = require('./notification-time');
class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', company_id INTEGER REFERENCES companies(id),
        active INTEGER NOT NULL DEFAULT 0, order_enabled INTEGER NOT NULL DEFAULT 0,
        stock_enabled INTEGER NOT NULL DEFAULT 0, report_enabled INTEGER NOT NULL DEFAULT 0, alerts_enabled INTEGER NOT NULL DEFAULT 0,
        alerts_time TEXT NOT NULL DEFAULT '${DEFAULT_NOTIFICATION_TIME}',
        bot_present INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_group_per_company ON groups(company_id) WHERE active=1 AND company_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, payload TEXT, state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT,
        group_id TEXT, company_id INTEGER, action TEXT NOT NULL, outcome TEXT NOT NULL,
        reference TEXT, endpoint TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      group_id TEXT NOT NULL, day TEXT NOT NULL, company_id INTEGER NOT NULL, revision INTEGER NOT NULL,
      retry_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending', payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, day)
    )`);
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(groups)').all().map(c => c.name));
      if (!columns.has('stock_enabled')) this.db.exec('ALTER TABLE groups ADD COLUMN stock_enabled INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('report_enabled')) this.db.exec('ALTER TABLE groups ADD COLUMN report_enabled INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('alerts_enabled')) this.db.exec('ALTER TABLE groups ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('alerts_time')) this.db.exec(`ALTER TABLE groups ADD COLUMN alerts_time TEXT NOT NULL DEFAULT '${DEFAULT_NOTIFICATION_TIME}'`);
    });
    // Use a single app replica with SQLite. Recover jobs after an interrupted restart.
    this.db.prepare("UPDATE jobs SET state='pending' WHERE state='processing'").run();
    this.cleanup();
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  companies() { return this.db.prepare('SELECT id, name FROM companies ORDER BY name').all(); }
  saveCompanies(companies) {
    const put = this.db.prepare('INSERT INTO companies(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
    this.transaction(() => { for (const c of companies) put.run(c.id, c.name); });
  }
  groups() { return this.db.prepare(`SELECT g.*, c.name AS company_name FROM groups g LEFT JOIN companies c ON c.id=g.company_id ORDER BY g.active, g.last_seen DESC`).all(); }
  group(id) { return this.db.prepare('SELECT g.*, c.name AS company_name FROM groups g LEFT JOIN companies c ON c.id=g.company_id WHERE g.id=?').get(id); }
  discover(id, timestamp, leaving = false) {
    this.db.prepare(`INSERT INTO groups(id,last_seen,created_at,bot_present) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,bot_present=excluded.bot_present
      WHERE excluded.last_seen >= groups.last_seen`).run(id, timestamp, Date.now(), leaving ? 0 : 1);
    if (leaving) this.db.prepare('UPDATE groups SET active=0, revision=revision+1 WHERE id=? AND last_seen<=?').run(id, timestamp);
  }
  rename(id, name) { this.db.prepare("UPDATE groups SET name=? WHERE id=? AND name=''").run(name.slice(0, 120), id); }
  mapGroup(id, { companyId, active, orderEnabled, stockEnabled = false, reportEnabled = false, alertsEnabled = false, alertsTime, name, revision }, actor) {
    return this.transaction(() => {
      const current = this.group(id);
      if (!current) throw Object.assign(new Error('ไม่พบกลุ่มนี้'), { status: 404 });
      if (current.revision !== revision) throw Object.assign(new Error('ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่ก่อนบันทึก'), { status: 409 });
      if (active && (!companyId || !current.bot_present)) throw Object.assign(new Error('ต้องเลือกบริษัทและเชิญ Bot เข้ากลุ่มก่อนเปิดใช้งาน'), { status: 400 });
      if (alertsEnabled && (!active || !reportEnabled)) throw Object.assign(new Error('ต้องเปิดใช้งานกลุ่มและสิทธิ์รายงานก่อนเปิดแจ้งเตือน'), { status: 400 });
      if (alertsTime !== undefined && !isNotificationTime(alertsTime)) throw Object.assign(new Error('กรุณาเลือกเวลาแจ้งเตือนระหว่าง 00:00 ถึง 23:59'), { status: 400 });
      if (companyId && !this.db.prepare('SELECT id FROM companies WHERE id=?').get(companyId)) throw Object.assign(new Error('กรุณาเลือกบริษัทจากรายการ ShipX'), { status: 400 });
      try {
        this.db.prepare('UPDATE groups SET company_id=?, active=?, order_enabled=?, stock_enabled=?, report_enabled=?, alerts_enabled=?, alerts_time=?, name=?, revision=revision+1 WHERE id=?')
          .run(companyId, +active, +orderEnabled, +stockEnabled, +reportEnabled, +alertsEnabled, alertsTime ?? current.alerts_time, name, id);
      } catch (e) {
        if (e.message.includes('UNIQUE')) throw Object.assign(new Error('บริษัทนี้มีกลุ่มที่เปิดใช้งานอยู่แล้ว กรุณาปิดกลุ่มเดิมก่อน'), { status: 409 });
        throw e;
      }
      this.audit({ actor, groupId: id, companyId, action: 'mapping.update', outcome: active && (orderEnabled || stockEnabled || reportEnabled) ? 'enabled' : 'disabled' });
      return this.group(id);
    });
  }
  audit({ actor = null, groupId = null, companyId = null, action, outcome, reference = null, endpoint = null }) {
    this.db.prepare('INSERT INTO audit(at,actor,group_id,company_id,action,outcome,reference,endpoint) VALUES(?,?,?,?,?,?,?,?)')
      .run(Date.now(), actor, groupId, companyId, action, outcome, reference, endpoint);
  }
  audits() { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(); }
  stats() {
    return {
      groups: this.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n,
      active: this.db.prepare('SELECT COUNT(*) AS n FROM groups WHERE active=1 AND (order_enabled=1 OR stock_enabled=1 OR report_enabled=1) AND bot_present=1').get().n,
      pending: this.db.prepare('SELECT COUNT(*) AS n FROM groups WHERE company_id IS NULL').get().n,
      queries: this.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('order.lookup','stock.lookup','report.overview','report.sales','report.shipping','report.shipping_issues') AND at>?").get(Date.now() - 86400000).n,
      queue: this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('pending','processing')").get().n,
    };
  }
  enqueue(events) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO jobs(id,payload,created_at) VALUES(?,?,?)');
    this.transaction(() => { for (const event of events) insert.run(event.webhookEventId, JSON.stringify(event), Date.now()); });
  }
  nextJob() {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE state='pending' ORDER BY created_at,rowid LIMIT 1").get();
      if (job) this.db.prepare("UPDATE jobs SET state='processing', attempts=attempts+1 WHERE id=?").run(job.id);
      return job;
    });
  }
  finishJob(id, failed = false) { this.db.prepare('UPDATE jobs SET state=?,payload=NULL WHERE id=?').run(failed ? 'failed' : 'done', id); }
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    this.db.prepare("DELETE FROM jobs WHERE created_at<? AND state IN ('done','failed')").run(now - 7 * 86400000);
    this.db.prepare('DELETE FROM audit WHERE at<?').run(now - 90 * 86400000);
    this.db.prepare("UPDATE notifications SET payload=NULL,state='expired' WHERE state='pending' AND day < ?").run(new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Bangkok' }).format(now));
    this.db.prepare('DELETE FROM notifications WHERE day < ?').run(new Date(now - 8 * 86400000).toISOString().slice(0,10));
  }
  seedDemo() {
    this.saveCompanies([{ id: 101, name: 'ABC Logistics' }, { id: 202, name: 'บริษัท สยามรีเทล จำกัด' }]);
    const first = 'C' + '1'.repeat(32), second = 'C' + '2'.repeat(32);
    if (!this.group(first)) {
      this.discover(first, Date.now());
      this.mapGroup(first, { companyId: 101, active: true, orderEnabled: true, stockEnabled: true, reportEnabled: true, name: 'ABC • Order Support', revision: 0 }, 'demo');
      this.discover(second, Date.now() - 3600000);
      this.rename(second, 'Siam Retail • Operations');
    }
  }
}
module.exports = { Store };
