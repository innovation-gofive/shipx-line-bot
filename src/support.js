const { randomUUID, createHash } = require('node:crypto');
const { card } = require('./replies');
const { failureReason } = require('./service-error');
const GROUP_ID = /^C[0-9a-f]{32}$/i;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const caseNumber = id => `SH-${String(id).padStart(6, '0')}`;
const reasons = {
  unsupported: 'ยังไม่เข้าใจคำถาม', upstream_error: 'ตรวจข้อมูลจาก ShipX ไม่สำเร็จ',
  configuration_required: 'ต้องตรวจการตั้งค่า', stock_unavailable: 'ยังตรวจยอดสต๊อกไม่ได้',
  ambiguous: 'ยังระบุรายการเดียวไม่ได้', search_limit: 'ค้นหาเกินขอบเขต',
};

class SupportDesk {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS support_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL, company_id INTEGER NOT NULL, group_name TEXT NOT NULL,
      company_name TEXT NOT NULL, mapping_revision INTEGER NOT NULL, actor TEXT,
      question TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT,
      status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      updated_by TEXT, source TEXT NOT NULL DEFAULT 'line'
    );
    CREATE INDEX IF NOT EXISTS support_status ON support_cases(status, created_at);
    CREATE TABLE IF NOT EXISTS admin_alert_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, group_id TEXT);
    CREATE TABLE IF NOT EXISTS admin_alert_jobs (
      job_key TEXT PRIMARY KEY, case_id INTEGER, kind TEXT NOT NULL, metadata TEXT,
      target_group_id TEXT, retry_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_migrations (id TEXT PRIMARY KEY);`);
  }
  counts() {
    const counts = { open: 0, in_progress: 0, resolved: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM support_cases GROUP BY status').all()) counts[row.status] = row.n;
    return { ...counts, pending: counts.open + counts.in_progress };
  }
  settings() {
    const row = this.db.prepare('SELECT * FROM admin_alert_settings WHERE id=1').get();
    const group = row?.group_id && this.store.group(row.group_id);
    return { enabled: !!row?.enabled, groupId: row?.group_id || '', groupName: group?.name || '',
      ready: !!(row?.enabled && group?.bot_present && !group.company_id) };
  }
  saveSettings({ enabled, groupId }, actor) {
    if (typeof enabled !== 'boolean' || typeof groupId !== 'string' || (groupId && !GROUP_ID.test(groupId))) throw invalid('เลือกกลุ่ม LINE ของทีม Admin ให้ถูกต้อง');
    const group = groupId && this.store.group(groupId);
    if (enabled && (!group?.bot_present || group.company_id)) throw invalid('ใช้กลุ่มทีม Admin ที่มีบอทอยู่และไม่ได้ผูกบริษัทลูกค้า');
    this.db.prepare('INSERT INTO admin_alert_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,group_id=excluded.group_id').run(+enabled, groupId || null);
    this.store.audit({ actor, action: 'support.settings', outcome: enabled ? 'enabled' : 'disabled' });
    return this.settings();
  }
  create({ requestId, group, actor, question, reason, detail = null }, now = Date.now()) {
    return this.store.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO support_cases
        (request_id,group_id,company_id,group_name,company_name,mapping_revision,actor,question,reason,detail,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(requestId, group.id, group.company_id, group.name || group.id,
        group.company_name || `Company ${group.company_id}`, group.revision, actor, question, reason, detail, now, now);
      const row = this.db.prepare('SELECT * FROM support_cases WHERE request_id=?').get(requestId);
      this.db.prepare(`INSERT OR IGNORE INTO admin_alert_jobs(job_key,case_id,kind,retry_key,created_at) VALUES(?,?,'question',?,?)`)
        .run(`case:${row.id}`, row.id, randomUUID(), now);
      return row;
    });
  }
  list({ status = 'pending', query = '', page = 1, caseId } = {}) {
    if (!['pending','open','in_progress','resolved','all'].includes(status) || typeof query !== 'string' || query.length > 120 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000 || (caseId !== undefined && (!Number.isSafeInteger(caseId) || caseId < 1))) throw invalid('ตัวกรองคำถามไม่ถูกต้อง');
    const terms = [], values = [];
    if (status === 'pending') terms.push("c.status IN ('open','in_progress')");
    else if (status !== 'all') { terms.push('c.status=?'); values.push(status); }
    if (caseId !== undefined) { terms.push('c.id=?'); values.push(caseId); }
    if (query.trim()) {
      terms.push("(instr(lower(c.question),lower(?))>0 OR instr(lower(c.group_name),lower(?))>0 OR instr(lower(c.company_name),lower(?))>0 OR instr(c.group_id,?)>0)");
      values.push(...Array(4).fill(query.trim()));
    }
    const where = terms.length ? ' WHERE ' + terms.join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM support_cases c' + where).get(...values).n;
    const rows = this.db.prepare(`SELECT c.*, j.state AS alert_state,
      g.revision AS current_revision, g.company_id AS current_company_id
      FROM support_cases c LEFT JOIN admin_alert_jobs j ON j.case_id=c.id
      LEFT JOIN groups g ON g.id=c.group_id${where} ORDER BY c.created_at DESC,c.id DESC LIMIT 25 OFFSET ?`).all(...values, (page - 1) * 25);
    return { rows, total, page, pageSize: 25, counts: this.counts() };
  }
  update(id, { status, note, version }, actor) {
    if (!Number.isSafeInteger(id) || id < 1 || !['open','in_progress','resolved'].includes(status) || typeof note !== 'string' || note.length > 2000 || !Number.isSafeInteger(version) || version < 0) throw invalid('ข้อมูลรับเรื่องไม่ถูกต้อง');
    return this.store.transaction(() => {
      if (!this.db.prepare('SELECT id FROM support_cases WHERE id=?').get(id)) throw invalid('ไม่พบคำถามนี้', 404);
      const result = this.db.prepare('UPDATE support_cases SET status=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?')
        .run(status, note, Date.now(), actor, id, version);
      if (!result.changes) throw invalid('มีผู้ดูแลอัปเดตเรื่องนี้แล้ว กรุณาโหลดใหม่', 409);
      this.store.audit({ actor, action:'support.update', outcome:status, reference:caseNumber(id) });
      return this.db.prepare('SELECT * FROM support_cases WHERE id=?').get(id);
    });
  }
  importHistory(adminUsername) {
    if (this.db.prepare("SELECT id FROM support_migrations WHERE id='history-v1'").get()) return;
    this.store.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM audit WHERE question IS NOT NULL AND question!='' AND actor!=?
        AND (action='bot.request' AND outcome='help' OR
          action IN ('order.lookup','stock.lookup','stock.overview','stock.reorder','report.overview','report.shipping','report.shipping_issues','report.daily_shipped','report.sales')
          AND outcome IN ('upstream_error','stock_unavailable','ambiguous','search_limit','configuration_required')) ORDER BY id`).all(adminUsername || 'admin');
      for (const row of rows) {
        if (!/^U[a-f0-9]{32}$/i.test(row.actor || '') || /^(?:@\S+\s*)?(?:help|ช่วยเหลือ|วิธีใช้)?$/i.test(row.question.trim())) continue;
        const group = this.store.group(row.group_id);
        if (!group || !row.company_id) continue;
        this.db.prepare(`INSERT OR IGNORE INTO support_cases(request_id,group_id,company_id,group_name,company_name,mapping_revision,actor,question,reason,detail,created_at,updated_at,source)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'history')`).run(`audit:${row.id}`,group.id,row.company_id,group.name || group.id,
          this.db.prepare('SELECT name FROM companies WHERE id=?').get(row.company_id)?.name || `Company ${row.company_id}`,
          -1,row.actor,row.question,row.outcome==='help'?'unsupported':row.outcome,row.detail,row.at,row.at);
      }
      this.db.prepare("INSERT INTO support_migrations VALUES('history-v1')").run();
    });
  }
  queueToken(status, now = Date.now()) {
    if (!['expiring','expired','unreadable','auto_error'].includes(status.warning)) return;
    const metadata = { warning: status.warning, expiresAt: status.expiresAt, error:status.automatic?.lastError || null };
    const key = createHash('sha256').update(JSON.stringify([status.source,status.updatedAt,status.expiresAt,status.warning,metadata.error])).digest('hex');
    this.db.prepare("INSERT OR IGNORE INTO admin_alert_jobs(job_key,kind,metadata,retry_key,created_at) VALUES(?,'token',?,?,?)")
      .run(`token:${key}`, JSON.stringify(metadata), randomUUID(), now);
  }
  async flush(line, origin, now = Date.now(), tokenStatus = null, canContinue = () => true) {
    const settings = this.settings();
    if (!settings.ready) return;
    const jobs = this.db.prepare("SELECT * FROM admin_alert_jobs WHERE state='pending' AND next_attempt<=? ORDER BY created_at LIMIT 5").all(now);
    for (const job of jobs) {
      if (!canContinue()) return;
      const current = this.settings();
      if (!current.ready || current.groupId !== settings.groupId) return;
      if (job.target_group_id && job.target_group_id !== settings.groupId) {
        this.db.prepare("UPDATE admin_alert_jobs SET state='cancelled' WHERE job_key=?").run(job.job_key); continue;
      }
      let reply;
      const url = new URL('/', origin);
      if (job.kind === 'question') {
        const item = this.db.prepare('SELECT * FROM support_cases WHERE id=?').get(job.case_id);
        if (!item || item.status === 'resolved') { this.db.prepare("UPDATE admin_alert_jobs SET state='cancelled' WHERE job_key=?").run(job.job_key); continue; }
        url.searchParams.set('view','unanswered'); url.searchParams.set('case',item.id);
        reply = card('💬 คำถามรอ Admin', `${caseNumber(item.id)} · ${item.company_name}`,
          [{ rows:[['กลุ่มลูกค้า',item.group_name],['สาเหตุ',reasons[item.reason] || 'ต้องตรวจสอบเพิ่มเติม']],detail:item.question }],
          'โปรดรับเรื่องในหน้า Admin และตอบลูกค้าในกลุ่ม LINE เดิม', undefined, undefined, 'SHINY · ADMIN DESK');
      } else {
        const meta = JSON.parse(job.metadata);
        if (!tokenStatus || tokenStatus.warning !== meta.warning || tokenStatus.expiresAt !== meta.expiresAt || (meta.error || null)!==(tokenStatus.automatic?.lastError || null)) {
          this.db.prepare("UPDATE admin_alert_jobs SET state='cancelled' WHERE job_key=?").run(job.job_key); continue;
        }
        url.searchParams.set('view','settings');
        const expiry = meta.expiresAt ? new Intl.DateTimeFormat('th-TH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(meta.expiresAt) : 'ตรวจสอบในหน้าตั้งค่า';
        reply = card('🔑 ตรวจ Token ของ ShipX', meta.warning==='auto_error'?'ต่ออายุ Token อัตโนมัติไม่สำเร็จ':meta.warning==='expired'?'Token หมดอายุแล้ว':meta.warning==='unreadable'?'อ่าน Token ที่บันทึกไว้ไม่ได้':'Token จะหมดอายุภายใน 24 ชั่วโมง',
          [{rows:[['วันหมดอายุ',expiry]]}], meta.warning==='auto_error'?'เปิดหน้าการเชื่อมต่อเพื่อตรวจข้อมูลแอป GoFive และการต่ออายุอัตโนมัติ':'เปิดหน้าการเชื่อมต่อเพื่อบันทึก Token ใหม่ โดยไม่ต้อง Redeploy',undefined,undefined,'SHINY · ADMIN DESK');
      }
      reply.message.contents.footer.contents.unshift({type:'button',style:'primary',height:'sm',action:{type:'uri',label:'เปิดหน้า Admin',uri:url.href}});
      this.db.prepare('UPDATE admin_alert_jobs SET target_group_id=?,attempts=attempts+1,next_attempt=? WHERE job_key=?')
        .run(settings.groupId, now + 60000 * (2 ** job.attempts), job.job_key);
      try {
        await line.push(settings.groupId, reply.message, job.retry_key);
        this.db.prepare("UPDATE admin_alert_jobs SET state='sent' WHERE job_key=?").run(job.job_key);
        this.store.audit({action:'support.notify',outcome:'sent',reference:job.case_id?caseNumber(job.case_id):'token'});
      } catch (error) {
        const terminal = error.retryable === false || job.attempts >= 4;
        if (terminal) this.db.prepare("UPDATE admin_alert_jobs SET state='failed' WHERE job_key=?").run(job.job_key);
        this.store.audit({action:'support.notify',outcome:terminal?'failed':'retry_pending',detail:failureReason(error),reference:job.case_id?caseNumber(job.case_id):'token'});
      }
    }
  }
}
module.exports = { SupportDesk, caseNumber, reasons };
