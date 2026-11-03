const { SEARCH_ENDPOINT } = require('./shipx');
const HELP = 'สอบถามสถานะ Order ของบริษัทในกลุ่มนี้\nพิมพ์ order SO001 หรือ สถานะ SO001\nค้นหาได้ด้วยเลขเอกสาร, Movement, เลข Order แพลตฟอร์ม หรือเลขพัสดุ';
const NOT_FOUND = 'ไม่พบ Order นี้ในบริษัทที่ผูกกับกลุ่ม กรุณาตรวจสอบเลข Order อีกครั้ง';
const GROUP_ID = /^C[0-9a-f]{32}$/i;
function parseCommand(text) {
  if (typeof text !== 'string' || text.length > 250) return null;
  const normalized = text.trim().replace(/^@ShipXBot\s+/i, '');
  if (/^(help|ช่วยเหลือ|วิธีใช้)$/i.test(normalized)) return { type: 'help' };
  const match = /^(?:order|status|สถานะ(?:ออเดอร์)?|เช็ค(?:สถานะ)?)\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,99})$/i.exec(normalized);
  return match ? { type: 'order', reference: match[1] } : null;
}
function allowed(group) { return !!(group?.active && group.order_enabled && group.bot_present && group.company_id); }
async function answerOrder({ store, shipx, groupId, text, actor = null }) {
  const command = parseCommand(text), group = store.group(groupId);
  const audit = { actor, groupId, companyId: group?.company_id || null, action: 'order.lookup', reference: command?.reference || null, endpoint: null };
  if (!allowed(group)) {
    store.audit({ ...audit, outcome: 'denied' });
    return { text: 'กลุ่มนี้ยังไม่ได้รับสิทธิ์สอบถาม Order กรุณาติดต่อผู้ดูแลเพื่อผูกบริษัทและเปิดสิทธิ์', revision: group?.revision };
  }
  if (!command || command.type === 'help') return { text: HELP, revision: group.revision };
  let result;
  try { result = await shipx.findOrder(group.company_id, command.reference); }
  catch { result = { outcome: 'upstream_error' }; }
  const current = store.group(groupId);
  if (!allowed(current) || current.revision !== group.revision || current.company_id !== group.company_id) {
    store.audit({ ...audit, endpoint: SEARCH_ENDPOINT, outcome: 'mapping_changed' });
    return { text: 'การตั้งค่ากลุ่มเปลี่ยนระหว่างสอบถาม กรุณาลองใหม่อีกครั้ง', revision: current?.revision };
  }
  store.audit({ ...audit, endpoint: SEARCH_ENDPOINT, outcome: result.outcome });
  if (result.outcome === 'upstream_error') return { text: 'ขณะนี้เชื่อมต่อ ShipX ไม่สำเร็จ กรุณาลองใหม่ภายหลัง', revision: group.revision };
  if (result.outcome === 'ambiguous' || result.outcome === 'search_limit') return { text: 'ยังระบุ Order เดียวไม่ได้ กรุณาใช้เลขเอกสาร Order ที่ครบถ้วน', revision: group.revision };
  if (!result.order) return { text: NOT_FOUND, revision: group.revision };
  const o = result.order;
  return { text: [`Order ${o.orderNo}`, `สถานะ: ${o.status}`, o.tracking && `เลขพัสดุ: ${o.tracking}`, o.carrier && `ขนส่ง: ${o.carrier}`].filter(Boolean).join('\n'), revision: group.revision };
}
function createWorker({ config, store, shipx, line }) {
  let running = false, stopping = false, timer, current;
  const limits = new Map();
  async function processEvent(event, receivedAt) {
    const groupId = event.source?.groupId;
    if (event.source?.type !== 'group' || !GROUP_ID.test(groupId || '')) return;
    if (Date.now() - event.timestamp > 20 * 60000) return;
    store.discover(groupId, event.timestamp, event.type === 'leave');
    if (event.type === 'leave') {
      store.audit({ groupId, action: 'group.leave', outcome: 'disabled' });
      return;
    }
    if (event.type === 'join') {
      try { const name = await line.groupName(groupId); if (name) store.rename(groupId, name); } catch { /* Name lookup is optional. */ }
      store.audit({ groupId, action: 'group.join', outcome: 'pending_review' });
      return;
    }
    if (event.type !== 'message' || event.message?.type !== 'text') return;
    const command = parseCommand(event.message.text);
    if (!command) return;
    const now = Date.now();
    if (now - receivedAt > 45000 || now - event.timestamp > 55000) {
      store.audit({ groupId, action: 'line.reply', outcome: 'expired' });
      return;
    }
    const bucket = limits.get(groupId) || { start: now, count: 0 };
    if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
    limits.set(groupId, bucket);
    for (const [key, item] of limits) if (now - item.start > 120000) limits.delete(key);
    if (++bucket.count > 20) { store.audit({ groupId, action: 'order.lookup', outcome: 'rate_limited' }); return; }
    const result = await answerOrder({ store, shipx, groupId, text: event.message.text, actor: event.source.userId || null });
    const latest = store.group(groupId);
    if (latest?.revision !== result.revision) return;
    if (event.replyToken && Date.now() - receivedAt < 50000) await line.reply(event.replyToken, result.text);
  }
  async function tick() {
    if (running || stopping) return;
    running = true;
    try {
      let job;
      while (!stopping && (job = store.nextJob())) {
        try { await processEvent(JSON.parse(job.payload), job.created_at); store.finishJob(job.id); }
        catch { store.audit({ action: 'webhook.process', outcome: 'failed', reference: job.id }); store.finishJob(job.id, true); }
      }
    } finally { running = false; }
  }
  return {
    tick,
    start() {
      timer = setInterval(() => {
        if (!running && !stopping) current = tick().catch(() => console.error('Worker failed; inspect database availability.'));
      }, 250);
      timer.unref();
    },
    async stop() { stopping = true; clearInterval(timer); await current; },
  };
}
module.exports = { createWorker, answerOrder, parseCommand, GROUP_ID, HELP, NOT_FOUND };
