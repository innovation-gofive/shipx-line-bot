const { randomUUID } = require('node:crypto');
const { shippingReply } = require('./replies');
const { reportDates } = require('./shipx');
const { createPresenter } = require('./ai-response');
const { NOTIFICATION_TIME_ZONE } = require('./notification-time');
const time = new Intl.DateTimeFormat('en-GB', { timeZone: NOTIFICATION_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const permitted = group => !!(group?.active && group.bot_present && group.company_id && group.report_enabled && group.alerts_enabled);

function minutesSinceMidnight(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function inNotificationWindow(now, scheduledTime) {
  const elapsed = minutesSinceMidnight(time.format(now)) - minutesSinceMidnight(scheduledTime);
  return elapsed >= 0 && elapsed < 15;
}

function createNotifications({ config, store, shipx, line, clock = () => new Date(), present = createPresenter(config) }) {
  let running = false, stopping = false, timer, current;
  const record = (groupId, day) => store.db.prepare('SELECT * FROM notifications WHERE group_id=? AND day=?').get(groupId, day);
  const finish = (group, day, state) => store.db.prepare('UPDATE notifications SET state=?,payload=NULL WHERE group_id=? AND day=?').run(state, group.id, day);
  const matches = (group, job) => {
    const latest = store.group(group.id);
    return permitted(latest) && latest.company_id === job.company_id && latest.revision === job.revision;
  };
  async function tick() {
    if (running || stopping || config.demo || !config.shippingDateIsDueDate) return;
    running = true;
    try {
      for (const { id } of store.groups().filter(permitted)) {
        if (stopping) break;
        const group = store.group(id);
        if (!permitted(group)) continue;
        const now = clock();
        if (!inNotificationWindow(now, group.alerts_time)) continue;
        const [day] = reportDates(1, now);
        store.db.prepare('INSERT OR IGNORE INTO notifications(group_id,day,company_id,revision,retry_key) VALUES(?,?,?,?,?)')
          .run(group.id, day, group.company_id, group.revision, randomUUID());
        let job = record(group.id, day);
        if (job.state !== 'pending' || job.next_attempt > now.getTime()) continue;
        if (!matches(group, job)) { finish(group, day, 'cancelled'); continue; }
        try {
          store.db.prepare('UPDATE notifications SET attempts=attempts+1,next_attempt=? WHERE group_id=? AND day=?')
            .run(now.getTime() + 60000 * (2 ** job.attempts), group.id, day);
          if (!job.payload) {
            const report = await shipx.shippingProgress(job.company_id, now);
            if (!matches(group, job)) { finish(group, day, 'cancelled'); continue; }
            if (!report.toPack && !report.unknown) {
              finish(group, day, 'no_issues');
              store.audit({ groupId:group.id, companyId:job.company_id, action:'notification.shipping', outcome:'no_issues' });
              continue;
            }
            let reply = shippingReply(report, true, group.alerts_time);
            if (present) {
              const generated = await present(reply, { type: 'shipping_issues', canContinue: () => matches(group, job) });
              reply = generated.reply;
            }
            if (!matches(group, job)) { finish(group, day, 'cancelled'); continue; }
            store.db.prepare('UPDATE notifications SET payload=? WHERE group_id=? AND day=?')
              .run(JSON.stringify(reply.message), group.id, day);
            job = record(group.id, day);
          }
          if (stopping) break;
          if (!matches(group, job)) { finish(group, day, 'cancelled'); continue; }
          const sendTime = clock();
          if (!inNotificationWindow(sendTime, group.alerts_time) || reportDates(1, sendTime)[0] !== day) {
            finish(group, day, 'expired');
            continue;
          }
          await line.push(group.id, JSON.parse(job.payload), job.retry_key);
          finish(group, day, 'sent');
          store.audit({ groupId:group.id, companyId:job.company_id, action:'notification.shipping', outcome:'sent', endpoint:'/v2/bot/message/push' });
        } catch (error) {
          const attempts = record(group.id, day).attempts;
          const terminal = error.retryable === false || attempts >= 3;
          if (terminal) finish(group, day, 'failed');
          store.audit({ groupId:group.id, companyId:job.company_id, action:'notification.shipping', outcome:terminal ? 'failed' : 'retry_pending' });
        }
      }
    } finally { running = false; }
  }
  return {
    tick,
    start() {
      const run = () => { if (!running && !stopping) current = tick().catch(() => console.error('Notification scheduler failed; inspect database availability.')); };
      timer = setInterval(run, 30000); timer.unref(); run();
    },
    async stop() { stopping = true; clearInterval(timer); await current; },
  };
}
module.exports = { createNotifications };
