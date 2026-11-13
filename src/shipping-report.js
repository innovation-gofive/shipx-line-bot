const types = [['b2c', 'B2C'], ['b2b', 'B2B'], ['unknown', 'ยังไม่ระบุประเภท']];
const stages = [['pickup', 'รอรถมารับ'], ['notReady', 'ยังไม่พร้อมจัดส่ง'], ['unknown', 'ต้องตรวจสถานะ']];
const number = new Intl.NumberFormat('th-TH');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function shippingOrderSections(orders) {
  return types.filter(([type]) => type !== 'unknown' || orders[type].length).map(([type, label]) => ({
    label,
    count: orders[type].length,
    stages: stages.map(([key, name]) => ({ key, name, orders: orders[type].filter(order => order.stage === key) })),
  }));
}

function renderShippingReport({ companyName, day, time, orders }) {
  const sections = shippingOrderSections(orders);
  const total = sections.reduce((sum, section) => sum + section.count, 0);
  const groups = sections.filter(section => section.count).map(section => `
    <section class="order-group">
      <h2>${section.label}<span>${number.format(section.count)} ออเดอร์</span></h2>
      ${section.stages.filter(stage => stage.orders.length).map(stage => `
        <div class="order-stage">
          <h3>${stage.name} <span>${number.format(stage.orders.length)}</span></h3>
          <table aria-label="${section.label} ${stage.name}">
            <thead><tr><th scope="col">เลขออเดอร์</th><th scope="col">สถานะใน ShipX</th></tr></thead>
            <tbody>${stage.orders.map(order => `<tr><td>${escape(order.orderNo)}</td><td>${escape(order.status)}</td></tr>`).join('')}</tbody>
          </table>
        </div>`).join('')}
    </section>`).join('');
  return `<header class="report-header">
    <h1>ออเดอร์ที่ยังไม่ได้จัดส่ง</h1>
    <p class="company">${escape(companyName)}</p>
    <p class="report-time">กำหนดส่ง ${escape(day.split('-').reverse().join('/'))} · รอบ ${escape(time)} น. (เวลาไทย)</p>
    <p class="report-total"><strong>${number.format(total)}</strong> ออเดอร์</p>
  </header>${groups || '<p class="empty">ไม่มีออเดอร์ที่ต้องติดตามในรอบนี้</p>'}`;
}

function shippingReportPage(preview) {
  const assets = preview ? '../public/' : '/';
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>ออเดอร์ที่ยังไม่ได้จัดส่ง | ShipX</title>
  <link rel="stylesheet" href="${assets}shipping-orders.css">
  ${preview ? '' : '<script src="/shipping-orders.js" defer></script>'}
</head>
<body>
  <main id="shipping-report" ${preview ? '' : 'aria-busy="true"'}>
    ${preview ? renderShippingReport(preview) : '<p role="status" class="empty">กำลังเปิดรายการออเดอร์…</p>'}
  </main>
  <noscript><p class="empty">กรุณาเปิด JavaScript เพื่อดูรายการออเดอร์</p></noscript>
</body>
</html>`;
}

module.exports = { shippingOrderSections, renderShippingReport, shippingReportPage };
