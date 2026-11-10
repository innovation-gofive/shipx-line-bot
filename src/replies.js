const ink = '#172338', muted = '#667489', accent = '#0B62BE', warning = '#9C420E';
const number = new Intl.NumberFormat('th-TH');
const money = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = value => number.format(value);
const dateLabel = date => date.split('-').reverse().join('/');
const text = (value, options = {}) => ({ type: 'text', text: value, wrap: true, color: ink, size: 'sm', ...options });
const box = (contents, options = {}) => ({ type: 'box', layout: 'vertical', contents, spacing: 'sm', ...options });
const pair = ([label, value, highlight]) => ({
  type: 'box', layout: 'horizontal', spacing: 'sm',
  contents: [text(label, { color: muted, flex: 4 }), text(value, { flex: 6, align: 'end', weight: 'bold', color: highlight ? warning : ink })],
});

function card(title, subtitle, sections, note, altDetail = subtitle, metric) {
  const lines = [title, subtitle];
  if (metric) lines.push(`${metric.label}: ${metric.value}`);
  const cards = sections.map(({ heading, rows, detail }) => {
    if (heading) lines.push(heading);
    lines.push(...rows.map(([k, v]) => `${k}: ${v}`));
    if (detail) lines.push(detail);
    return box([
      ...(heading ? [text(heading, { size: 'sm', weight: 'bold', color: accent })] : []),
      ...rows.map(pair),
      ...(detail ? [text(detail, { size: 'xs', color: muted, margin: 'sm' })] : []),
    ], { backgroundColor: '#F7F9FC', paddingAll: '12px', cornerRadius: '10px' });
  });
  if (note) lines.push(note);
  const reply = {
    text: lines.join('\n'),
    message: {
      type: 'flex', altText: `${title} · ${altDetail}`.slice(0, 350).toWellFormed(),
      contents: {
        type: 'bubble', size: 'mega',
        header: box([text(title, { size: 'lg', weight: 'bold' }), text('ShipX  •  ข้อมูลล่าสุดจากระบบ', { color: muted, size: 'xs' })],
          { backgroundColor: '#FFFFFF', paddingTop: '18px', paddingBottom: '8px', paddingStart: '16px', paddingEnd: '16px' }),
        body: box([text(subtitle, { size: 'sm', color: muted }),
          ...(metric ? [box([text(metric.value, { size: 'xxl', weight: 'bold', color: metric.warning ? warning : accent }), text(metric.label, { size: 'xs', color: muted })])] : []),
          ...cards, ...(note ? [text(note, { size: 'xs', color: muted })] : [])],
          { spacing: 'md', paddingAll: '16px' }),
        footer: box([text('SHIPX  •  ข้อมูลเฉพาะบริษัทของกลุ่มนี้', { color: accent, size: 'xxs', align: 'center' })], { backgroundColor: '#EAF4FF', paddingAll: '10px' }),
      },
    },
  };
  Object.defineProperty(reply, 'view', { value: { title, subtitle, sections, note, altDetail, metric, variables: {} } });
  return reply;
}
function withVariables(reply, variables) { reply.view.variables = variables; return reply; }

function orderReply(order) {
  const rows = [['สถานะล่าสุด', order.status]];
  if (order.carrier) rows.push(['ขนส่ง', order.carrier]);
  if (order.tracking) rows.push(['เลขพัสดุ', order.tracking]);
  return withVariables(card('📦 สถานะออเดอร์', `Order  ${order.orderNo}`, [{ rows }], null, `${order.orderNo} · ${order.status}`), { status: order.status });
}

function stockReply(stock) {
  const rows = [['SKU', stock.sku]];
  if (stock.name) rows.push(['สินค้า', stock.name]);
  return withVariables(card('📦 ข้อมูลสต๊อกสินค้า', 'เช็กจำนวนพร้อมขายให้แล้วครับ', [{ rows }],
    stock.ready > 0 ? 'ยอดพร้อมขาย ณ เวลาที่สอบถามครับ' : 'ขณะนี้ยังไม่มีสินค้าพร้อมขายครับ',
    `${stock.sku} · พร้อมขาย ${fmt(stock.ready)}`, { label: 'จำนวนพร้อมขาย', value: fmt(stock.ready), warning: stock.ready <= 0 }), { ready: fmt(stock.ready) });
}

function overviewReply(days, offset = 0) {
  const hasPending = days.some(d => d.unpacked || d.awaitingShipment || d.attention);
  const hasUnknown = days.some(d => d.unknown);
  const subtitle = hasPending ? 'ยังมีออเดอร์ที่ต้องดำเนินการครับ' :
    hasUnknown ? 'มีบางออเดอร์ที่ยังแยกสถานะไม่ได้ครับ' : 'ไม่พบออเดอร์ค้างในสถานะที่ตรวจได้ครับ';
  const sections = days.map((day, i) => ({
    heading: `${['วันนี้', 'เมื่อวาน', 'สองวันก่อน'][offset + i]} · ${dateLabel(day.date)}`,
    rows: [
      ['ออเดอร์ทั้งหมด', fmt(day.total)],
      ['ยังแพ็คไม่เสร็จ', fmt(day.unpacked), day.unpacked > 0],
      ['แพ็คแล้ว / รอส่ง', fmt(day.awaitingShipment), day.awaitingShipment > 0],
      ['ต้องติดตาม', fmt(day.attention), day.attention > 0],
      ...(day.unknown ? [['ยังแยกสถานะไม่ได้', fmt(day.unknown), true]] : []),
    ],
    detail: day.pendingStatuses.map(status => `${status.label} ${fmt(status.count)}`).join(' · '),
  }));
  return withVariables(card('📋 ภาพรวมออเดอร์', subtitle, sections, 'แยกตามวันที่ของออเดอร์ เวลาไทย โดยใช้สถานะล่าสุดที่ ShipX รายงาน'), {
    total: fmt(days.reduce((sum, day) => sum + day.total, 0)),
    unpacked: fmt(days.reduce((sum, day) => sum + day.unpacked, 0)),
    unknown: fmt(days.reduce((sum, day) => sum + day.unknown, 0)),
  });
}

function salesReply(report) {
  const period = report.from === report.to ? dateLabel(report.to) : `${dateLabel(report.from)} ถึง ${dateLabel(report.to)}`;
  return withVariables(card('📊 รายงานยอดขาย', `ช่วงวันที่ ${period}`, [{ rows: [
    ['ยอดขายตาม ShipX', money.format(report.totalRevenue)],
    ['จำนวนออเดอร์', fmt(report.totalOrders)],
    ['จำนวนสินค้า', fmt(report.totalItems)],
  ] }], 'ตัวเลขรวมตามรายงาน ShipX ของบริษัทที่ผูกกับกลุ่ม'), { revenue: money.format(report.totalRevenue), orders: fmt(report.totalOrders) });
}

function shippingReply(report, issuesOnly = false, notificationTime = null) {
  const rows = [
    ['ต้องส่งทั้งหมด', fmt(report.due)],
    ['แพ็คเสร็จแล้ว', fmt(report.packed)],
    ['แพ็คแล้ว / รอส่ง', fmt(report.readyToShip)],
    ['ส่งออกจากคลังแล้ว', fmt(report.shipped)],
    ['ยังแพ็คไม่เสร็จ', fmt(report.toPack), report.toPack > 0],
    ...(report.unknown ? [['ยังตรวจสถานะไม่ได้', fmt(report.unknown), true]] : []),
  ];
  const sections = issuesOnly ? [{ rows: [
    ['ยังแพ็คไม่เสร็จ', fmt(report.toPack), true],
    ...(report.unknown ? [['ต้องตรวจสถานะเพิ่ม', fmt(report.unknown), true]] : []),
  ] }] : [{ heading: 'ความคืบหน้าออเดอร์ของวันที่เลือก', rows }];
  if (issuesOnly && report.problems.length) {
    sections.push({
      heading: `⚠️ ต้องติดตามก่อนส่ง ${fmt(report.toPack)} ออเดอร์`,
      rows: report.problems.map((order, i) => [`${i + 1}. ${order.orderNo}`, [order.platform, order.status].filter(Boolean).join(' · ')]),
      detail: report.toPack > report.problems.length ? `แสดง ${report.problems.length} รายการแรกจากทั้งหมด ${fmt(report.toPack)} รายการ` : undefined,
    });
  }
  const subtitle = `กำหนดส่ง ${dateLabel(report.date)} · ${notificationTime ? `แจ้งเตือนรอบ ${notificationTime} น.` : 'เวลาไทย'}`;
  const note = issuesOnly ? 'กรุณาตรวจสอบออเดอร์ที่ยังแพ็คไม่เสร็จก่อนส่งครับ' :
    `ไม่รวมยกเลิก ${fmt(report.cancelled)} และคืนสินค้า ${fmt(report.returns)} ออเดอร์ · ถาม “ออเดอร์ที่กำหนดส่งวันนี้แต่ยังแพ็คไม่เสร็จ” เพื่อดูรายการ`;
  return withVariables(card(issuesOnly ? '⚠️ ออเดอร์ที่ต้องติดตาม' : '🚚 ความคืบหน้าการจัดส่ง', subtitle, sections, note,
    `ต้องส่ง ${fmt(report.due)} · แพ็คแล้ว ${fmt(report.packed)} · ยังไม่เสร็จ ${fmt(report.toPack)}`,
    issuesOnly ? { label: 'ออเดอร์ที่ควรติดตามก่อนส่ง', value: `${fmt(report.toPack + report.unknown)} ออเดอร์`, warning: report.toPack + report.unknown > 0 } :
      { label: 'แพ็คเสร็จ / ออเดอร์ที่ต้องส่ง', value: report.packedPercent === null ? 'ไม่มีออเดอร์ต้องส่ง' : `${fmt(report.packedPercent)}%` }), {
    due: fmt(report.due), packed: fmt(report.packed), toPack: fmt(report.toPack), unknown: fmt(report.unknown),
  });
}

module.exports = { orderReply, stockReply, overviewReply, salesReply, shippingReply, card };
