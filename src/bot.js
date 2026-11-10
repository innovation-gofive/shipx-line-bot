const { SEARCH_ENDPOINT, VARIANT_ENDPOINT, STOCK_ENDPOINT, DAILY_ENDPOINT, SALES_ENDPOINT, SHIPPING_ENDPOINT } = require('./shipx');
const { parseCommand, interpret, createClassifier, HELP } = require('./intent');
const { createPresenter } = require('./ai-response');
const { orderReply, stockReply, overviewReply, salesReply, shippingReply } = require('./replies');
const NOT_FOUND = 'ไม่พบ Order นี้ในบริษัทที่ผูกกับกลุ่ม กรุณาตรวจสอบเลข Order อีกครั้ง';
const GROUP_ID = /^C[0-9a-f]{32}$/i;
const features = {
  order: { permission: 'order_enabled', action: 'order.lookup', endpoint: SEARCH_ENDPOINT, label: 'สอบถามสถานะออเดอร์' },
  stock: { permission: 'stock_enabled', action: 'stock.lookup', endpoint: VARIANT_ENDPOINT + ' + ' + STOCK_ENDPOINT, label: 'สอบถามสต๊อก' },
  overview: { permission: 'report_enabled', action: 'report.overview', endpoint: DAILY_ENDPOINT, label: 'ดูรายงานออเดอร์' },
  sales: { permission: 'report_enabled', action: 'report.sales', endpoint: SALES_ENDPOINT, label: 'ดูรายงานยอดขาย' },
  shipping: { permission: 'report_enabled', action: 'report.shipping', endpoint: SHIPPING_ENDPOINT, label: 'ดูความคืบหน้าการจัดส่ง' },
  shipping_issues: { permission: 'report_enabled', action: 'report.shipping_issues', endpoint: SHIPPING_ENDPOINT, label: 'ดูออเดอร์ที่ต้องติดตาม' },
};
function active(group) { return !!(group?.active && group.bot_present && group.company_id); }
async function answerCommand({ store, shipx, groupId, text, actor = null, classify = null, present = null }) {
  const group = store.group(groupId);
  const audit = { actor, groupId, companyId: group?.company_id || null, action: 'bot.request' };
  const plain = text => ({ text, revision: group?.revision });
  if (!active(group)) {
    store.audit({ ...audit, outcome: 'denied' });
    return plain('กลุ่มนี้ยังไม่ได้เปิดใช้งาน กรุณาติดต่อผู้ดูแลเพื่อผูกบริษัทและเปิดสิทธิ์ครับ');
  }
  const enabledTypes = Object.entries(features).filter(([, f]) => group[f.permission]).map(([type]) => type);
  const planner = classify && enabledTypes.length ? async (...args) => {
    let selected;
    try { selected = await classify(...args); }
    catch {
      store.audit({ ...audit, action: 'ai.command', endpoint: '/v1/responses', outcome: 'fallback' });
      return null;
    }
    store.audit({ ...audit, action: 'ai.command', endpoint: '/v1/responses', outcome: selected ? 'selected' : 'fallback', reference: Object.hasOwn(features, selected) ? selected : null });
    return selected;
  } : null;
  const command = await interpret(text, planner, enabledTypes);
  if (command.type === 'help') return plain(HELP);
  const feature = features[command.type];
  audit.action = feature.action;
  audit.reference = command.reference || null;
  const stillAllowed = () => {
    const current = store.group(groupId);
    return active(current) && current[feature.permission] && current.revision === group.revision && current.company_id === group.company_id;
  };
  const changed = () => {
    store.audit({ ...audit, outcome: 'mapping_changed' });
    return { text: 'การตั้งค่ากลุ่มเปลี่ยนระหว่างสอบถาม กรุณาลองใหม่อีกครั้งครับ', revision: store.group(groupId)?.revision };
  };
  if (!group[feature.permission]) {
    store.audit({ ...audit, outcome: 'denied' });
    return plain(`กลุ่มนี้ยังไม่มีสิทธิ์${feature.label} กรุณาติดต่อผู้ดูแลครับ`);
  }
  if (!stillAllowed()) return changed();
  let reply, outcome, configurationRequired = false;
  audit.endpoint = feature.endpoint;
  try {
    if (command.type === 'order') {
      const result = await shipx.findOrder(group.company_id, command.reference);
      outcome = result.outcome;
      if (outcome === 'found') reply = orderReply(result.order);
    } else if (command.type === 'stock') {
      const result = await shipx.findStock(group.company_id, command.reference);
      outcome = result.outcome;
      if (outcome === 'found') reply = stockReply(result.stock);
    } else if (['shipping', 'shipping_issues'].includes(command.type)) {
      reply = shippingReply(await shipx.shippingProgress(group.company_id, new Date(), command.offset || 0), command.type === 'shipping_issues');
      outcome = 'success';
    } else {
      const now = new Date(), offset = command.offset || 0;
      reply = command.type === 'sales' ? salesReply(await shipx.salesReport(group.company_id, command.days, now, offset)) :
        overviewReply(await shipx.orderOverview(group.company_id, command.days, now, offset), offset);
      outcome = 'success';
    }
  } catch (error) {
    configurationRequired = error.code === 'shipping_date_unconfirmed';
    outcome = configurationRequired ? 'configuration_required' : 'upstream_error';
  }
  if (!stillAllowed()) return changed();
  if (reply && present) {
    try {
      const composed = await present(reply, { type: command.type, canContinue: stillAllowed });
      if (!stillAllowed()) return changed();
      if (composed?.reply && ['generated', 'fallback'].includes(composed.outcome)) {
        reply = composed.reply;
        store.audit({ ...audit, action: 'ai.response', endpoint: '/v1/responses', reference: null, outcome: composed.outcome });
      }
    } catch { /* Keep the verified reply when response generation is unavailable. */ }
  }
  if (!stillAllowed()) return changed();
  store.audit({ ...audit, outcome });
  if (reply) return { ...reply, revision: group.revision };
  if (configurationRequired) return plain('รายงานกำหนดส่งยังไม่เปิดใช้งานครับ กรุณาให้ผู้ดูแลยืนยันฟิลด์วันที่กำหนดส่งของ ShipX ก่อน');
  if (outcome === 'not_found') return plain(command.type === 'stock' ? 'ไม่พบ SKU นี้ในบริษัทที่ผูกกับกลุ่ม กรุณาตรวจสอบรหัสสินค้าอีกครั้งครับ' : NOT_FOUND);
  if (outcome === 'stock_unavailable') return plain('พบ SKU นี้แล้ว แต่ยังตรวจสอบยอดสต๊อกไม่ได้ครับ');
  if (outcome === 'ambiguous' || outcome === 'search_limit') return plain(command.type === 'stock' ?
    'ยังระบุ SKU เดียวไม่ได้ กรุณาตรวจสอบรหัสสินค้าอีกครั้งครับ' : 'ยังระบุออเดอร์เดียวไม่ได้ กรุณาใช้เลขเอกสาร Order ที่ครบถ้วนครับ');
  return plain('ตอนนี้ยังตรวจสอบข้อมูลจาก ShipX ไม่ได้ กรุณาลองใหม่ภายหลังครับ');
}
function createWorker({ config, store, shipx, line, classify = createClassifier(config), present = createPresenter(config) }) {
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
    if (event.type !== 'message' || typeof event.command !== 'string' || !event.replyToken) return;
    const now = Date.now();
    if (now - receivedAt > 45000 || now - event.timestamp > 55000) {
      store.audit({ groupId, action: 'line.reply', outcome: 'expired' });
      return;
    }
    const bucket = limits.get(groupId) || { start: now, count: 0 };
    if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
    limits.set(groupId, bucket);
    for (const [key, item] of limits) if (now - item.start > 120000) limits.delete(key);
    if (++bucket.count > 20) { store.audit({ groupId, action: 'bot.request', outcome: 'rate_limited' }); return; }
    const result = await answerCommand({ store, shipx, groupId, text: event.command, actor: event.source.userId || null, classify, present });
    const latest = store.group(groupId);
    if (latest?.revision !== result.revision) return;
    if (Date.now() - receivedAt < 50000 && Date.now() - event.timestamp < 55000) await line.reply(event.replyToken, result.text, result.message);
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
module.exports = { createWorker, answerCommand, parseCommand, GROUP_ID, HELP, NOT_FOUND };
