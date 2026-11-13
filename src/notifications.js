const { randomUUID } = require('node:crypto');
const { shippingReply, dailyShippedReply, shippingFollowUpReply } = require('./replies');
const { reportDates } = require('./shipx');
const { createPresenter } = require('./ai-response');
const { NOTIFICATION_TIME_ZONE } = require('./notification-time');
const time = new Intl.DateTimeFormat('en-GB', { timeZone: NOTIFICATION_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const pendingAlert = { table: 'notifications', action: 'notification.shipping', flag: 'alerts_enabled', time: 'alerts_time' };
const dailySummary = { table: 'shipping_summary_notifications', action: 'notification.shipping_summary', flag: 'shipping_summary_enabled', time: 'shipping_summary_time' };
const permitted = (group, kind) => !!(group?.active && group.bot_present && group.company_id && group.report_enabled && group[kind.flag]);

function minutesSinceMidnight(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function notificationRun(now, scheduledTime, canCrossMidnight) {
  const elapsed = minutesSinceMidnight(time.format(now)) - minutesSinceMidnight(scheduledTime);
  const wrapped = elapsed < 0 && canCrossMidnight ? elapsed + 1440 : elapsed;
  if (wrapped < 0 || wrapped >= 15) return null;
  const [day] = reportDates(1, now, elapsed < 0 ? 1 : 0);
  return { day, cutoff: new Date(`${day}T${scheduledTime}:00+07:00`) };
}

function createNotifications({ config, store, shipx, line, clock = () => new Date(), present = createPresenter(config) }) {
  let running = false, stopping = false, timer, current;
  const stopSignal = new AbortController();
  const kinds = config.shippingDateIsDueDate ? [pendingAlert, dailySummary] : [dailySummary];

  async function run(group, kind, now, { day, cutoff }) {
    const { table, action } = kind;
    const isSummary = kind === dailySummary;
    const scheduledTime = group[kind.time];
    const record = () => store.db.prepare(`SELECT * FROM ${table} WHERE group_id=? AND day=?`).get(group.id, day);
    const finish = state => store.db.prepare(`UPDATE ${table} SET state=?,payload=NULL WHERE group_id=? AND day=?`).run(state, group.id, day);
    store.db.prepare(`INSERT OR IGNORE INTO ${table}(group_id,day,company_id,revision,retry_key) VALUES(?,?,?,?,?)`)
      .run(group.id, day, group.company_id, group.revision, randomUUID());
    let job = record();
    if (job.state !== 'pending' || job.next_attempt > now.getTime()) return;
    const matches = () => {
      const latest = store.group(group.id);
      return permitted(latest, kind) && latest.company_id === job.company_id && latest.revision === job.revision;
    };
    const audit = (outcome, endpoint) => store.audit({ groupId:group.id, companyId:job.company_id, action, outcome, endpoint });
    const savePayload = payload => store.db.prepare(`UPDATE ${table} SET payload=? WHERE group_id=? AND day=?`)
      .run(JSON.stringify(payload), group.id, day);
    if (!matches()) { finish('cancelled'); return; }
    try {
      store.db.prepare(`UPDATE ${table} SET attempts=attempts+1,next_attempt=? WHERE group_id=? AND day=?`)
        .run(now.getTime() + 60000 * (2 ** job.attempts), group.id, day);
      if (!job.payload) {
        if (isSummary) {
          const [report, followUp] = await Promise.all([
            shipx.dailyShippedOrders(job.company_id, cutoff, stopSignal.signal),
            config.shippingDateIsDueDate ? shipx.shippingFollowUp(job.company_id, cutoff, stopSignal.signal) : null,
          ]);
          const summary = dailyShippedReply(report, group.company_name || group.name, scheduledTime);
          if (!matches()) { finish('cancelled'); return; }
          store.transaction(() => {
            const messages = [summary.message];
            if (followUp) {
              let url;
              if (Object.values(followUp).some(orders => orders.length)) {
                const link = new URL('/shipping-orders', config.origin);
                link.hash = store.saveShippingReport(group, day, scheduledTime, followUp, clock().getTime());
                url = link.href;
              }
              messages.push(shippingFollowUpReply(followUp, day, scheduledTime, url).message);
            }
            savePayload(messages);
          });
        } else {
          const report = await shipx.shippingProgress(job.company_id, now);
          if (!matches()) { finish('cancelled'); return; }
          if (!report.toPack && !report.unknown) {
            finish('no_issues');
            audit('no_issues');
            return;
          }
          let reply = shippingReply(report, true, scheduledTime);
          if (present) {
            const generated = await present(reply, { type: 'shipping_issues', canContinue: matches });
            reply = generated.reply;
          }
          if (!matches()) { finish('cancelled'); return; }
          savePayload(reply.message);
        }
        job = record();
      }
      const payload = JSON.parse(job.payload);
      const batches = payload.batches || [{ messages: payload, key: job.retry_key }];
      for (let index = payload.next || 0; index < batches.length; index++) {
        if (stopping) return;
        if (!matches()) { finish('cancelled'); return; }
        if (notificationRun(clock(), scheduledTime, isSummary)?.day !== day) { finish('expired'); return; }
        const batch = batches[index];
        await line.push(group.id, batch.messages, batch.key);
        if (index + 1 < batches.length) savePayload({ batches, next: index + 1 });
      }
      finish('sent');
      audit('sent', '/v2/bot/message/push');
    } catch (error) {
      if (stopping && isSummary && stopSignal.signal.aborted && error.name === 'AbortError') {
        store.db.prepare(`UPDATE ${table} SET attempts=attempts-1,next_attempt=0 WHERE group_id=? AND day=?`).run(group.id, day);
        return;
      }
      const terminal = error.retryable === false || record().attempts >= 3;
      if (terminal) finish('failed');
      audit(terminal ? 'failed' : 'retry_pending');
    }
  }

  async function tick() {
    if (running || stopping || config.demo) return;
    running = true;
    try {
      const groups = store.groups();
      const results = await Promise.allSettled(kinds.map(async kind => {
        for (const { id } of groups.filter(group => permitted(group, kind))) {
          if (stopping) return;
          const group = store.group(id);
          if (!permitted(group, kind)) continue;
          const now = clock();
          const scheduled = notificationRun(now, group[kind.time], kind === dailySummary);
          if (scheduled) await run(group, kind, now, scheduled);
        }
      }));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    } finally { running = false; }
  }
  return {
    tick,
    start() {
      const run = () => { if (!running && !stopping) current = tick().catch(() => console.error('Notification scheduler failed; inspect database availability.')); };
      timer = setInterval(run, 30000); timer.unref(); run();
    },
    async stop() { stopping = true; clearInterval(timer); stopSignal.abort(); await current; },
  };
}
module.exports = { createNotifications };
