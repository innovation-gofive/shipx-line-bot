const { shippingOrderSections } = require('./shipping-report');
const { statusTheme } = require('./status');
const ink = '#172338', muted = '#667489', accent = '#0B62BE', warning = '#9C420E';
const number = new Intl.NumberFormat('th-TH');
const money = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = value => number.format(value);
const dateLabel = date => date.split('-').reverse().join('/');
const text = (value, options = {}) => ({ type: 'text', text: value, wrap: true, color: ink, size: 'sm', ...options });
const box = (contents, options = {}) => ({ type: 'box', layout: 'vertical', contents, spacing: 'sm', ...options });
const pair = ([label, value, highlight, style = {}], emphasis) => ({
  type: 'box', layout: 'horizontal', spacing: 'sm',
  contents: emphasis ? [
    text(label, { flex: 4, gravity: 'center', weight: 'bold', color: '#FFD36C', size: 'md' }),
    text(value, { flex: 6, align: 'end', weight: 'bold', color: '#FFFFFF', size: 'xxl' }),
  ] : [
    ...(style.logo ? [{ type: 'image', url: style.logo, size: 'xxs', aspectRatio: '1:1', flex: 0, margin: 'none' }] : []),
    text(label, { color: muted, flex: /^[\d,.%-]+$/.test(value) ? 7 : 4 }),
    text(value, { flex: /^[\d,.%-]+$/.test(value) ? 3 : 6, align: 'end', weight: 'bold', color: style.color || (highlight ? warning : ink) }),
  ],
});

function card(title, subtitle, sections, note, altDetail = subtitle, metric, footerLabel = 'Shiny × ShipX', theme = {}) {
  const lines = [title, subtitle];
  if (metric) lines.push(`${metric.label}: ${metric.value}`);
  const cards = sections.map(({ heading, rows, detail, emphasis }) => {
    if (heading) lines.push(heading);
    lines.push(...rows.map(([k, v]) => `${k}: ${v}`));
    if (detail) lines.push(detail);
    return box([
      ...(heading ? [text(heading, { size: 'sm', weight: 'bold', color: accent })] : []),
      ...rows.map(row => pair(row, emphasis)),
      ...(detail ? [text(detail, { size: 'xs', color: muted, margin: 'sm' })] : []),
    ], { backgroundColor: emphasis ? '#172C49' : '#F5F7FB', paddingAll: '16px', cornerRadius: '14px', borderWidth:'1px', borderColor:emphasis ? '#172C49' : '#E6ECF3' });
  });
  if (note) lines.push(note);
  const reply = {
    text: lines.join('\n'),
    message: {
      type: 'flex', altText: `${title} · ${altDetail}`.slice(0, 350).toWellFormed(),
      contents: {
        type: 'bubble', size: 'mega',
        header: box([text('SHINY  ×  SHIPX', {size:'xxs',weight:'bold',color:theme.color || '#FFD36C'}),
          text(title, { size: 'lg', weight: 'bold', color: theme.color || '#FFFFFF' }), text('ผู้ช่วยดูแลงานคลังของคุณ', { color: theme.color || '#D6E2F2', size: 'xxs' })],
          { backgroundColor: theme.background || '#172C49', paddingTop: '20px', paddingBottom: '18px', paddingStart: '20px', paddingEnd: '20px' }),
        body: box([text(subtitle, { size: theme.color ? 'lg' : 'md', weight:'bold', color:ink }),
          ...(metric ? [box([text(metric.value, { size: 'xxl', weight: 'bold', color: metric.warning ? warning : accent }), text(metric.label, { size: 'xs', color: muted })],
            {backgroundColor:metric.warning?'#FFF5E6':'#EAF4FF',paddingAll:'16px',cornerRadius:'14px'})] : []),
          ...cards, ...(note ? [text(note, { size: 'xs', color: muted })] : [])],
          { spacing: 'md', paddingAll: '20px' }),
        footer: box([text(footerLabel, { color: muted, size: 'xxs', align: 'center',weight:'bold' })], { backgroundColor: '#FFFFFF', paddingAll: '16px' }),
      },
    },
  };
  Object.defineProperty(reply, 'view', { value: { title, subtitle, sections, note, altDetail, metric, footerLabel, theme, variables: {} } });
  return reply;
}
function withVariables(reply, variables) { reply.view.variables = variables; return reply; }

function handoffReply(id, companyName) {
  const reference = id ? `SH-${String(id).padStart(6,'0')}` : 'รอตรวจสอบเพิ่มเติม';
  return card('💬 ให้แอดมินช่วยดูต่อค่ะ', 'Shiny ยังยืนยันคำตอบนี้ไม่ได้ค่ะ',
    [{ rows:[['สถานะ','รอแอดมินตรวจสอบ'],...(id ? [['เลขรับเรื่อง',reference]] : [])], detail:'รอทางแอดมินตรวจสอบเพิ่มเติมให้นะคะ 💛' }],
    id ? 'บันทึกคำถามให้ทีมดูแลแล้วค่ะ' : 'แอดมินจะช่วยตรวจข้อมูลเพิ่มเติมให้ค่ะ', reference,undefined,companyName || 'Shiny × ShipX',
    {color:'#9C650C',background:'#FFF1CF'});
}

function orderReply(order, companyName) {
  const theme = statusTheme(order.status);
  const rows = [['สถานะล่าสุด', order.status, false, {color: theme.color}]];
  if (order.carrier) rows.push(['ขนส่ง', order.carrier]);
  if (order.tracking) rows.push(['เลขพัสดุ', order.tracking]);
  return withVariables(card('📦 สถานะออเดอร์', `เลขออเดอร์ ${order.orderNo}`, [{ rows }], null,
    `${order.orderNo} · ${order.status}`, undefined, companyName || undefined, theme), { status: order.status });
}

function stockOverviewReply(report, reorderOnly = false, companyName = '', page = 0) {
  const start = page * 8;
  const rows = reorderOnly ? report.reorder.slice(start, start + 8).map(item => [item.sku, `${fmt(item.ready)} / ${fmt(item.reorderPoint)}`, true]) : [
    ['SKU ทั้งหมด', fmt(report.totalSkus)], ['มีพร้อมขาย', fmt(report.readySkus)],
    ['พร้อมขายหมด', fmt(report.outOfStockSkus), report.outOfStockSkus > 0],
    ['ถึงจุด Reorder', fmt(report.reorderSkus), report.reorderSkus > 0],
  ];
  if (!rows.length) rows.push(['ผลการตรวจ', 'ยังไม่มี SKU ถึงจุด Reorder']);
  return card(reorderOnly ? '🔔 สินค้าถึงจุด Reorder' : '📦 ภาพรวมสต็อก', companyName || 'ข้อมูลของบริษัทในกลุ่มนี้', [{
    heading: reorderOnly ? 'พร้อมขาย / จุด Reorder' : 'ตรวจจำนวนพร้อมขาย', rows,
    detail: reorderOnly && report.reorderSkus > 8 ? `แสดง ${start + 1}–${Math.min(start + 8, report.reorderSkus)} จาก ${fmt(report.reorderSkus)} SKU` : undefined,
  }], `${reorderOnly ? 'ถึงจุดเมื่อจำนวนพร้อมขาย ≤ Reorder Point ของ ShipX' : 'นับเฉพาะจำนวนพร้อมขาย'}${report.missingThresholdSkus ? ` · ยังไม่มีจุด Reorder ${fmt(report.missingThresholdSkus)} SKU` : ''}`,
  `${fmt(report.reorderSkus)} SKU ถึงจุด Reorder`, { label: reorderOnly ? 'ควรเติมสินค้า' : 'จำนวน SKU', value: fmt(reorderOnly ? report.reorderSkus : report.totalSkus), warning: reorderOnly && report.reorderSkus > 0 }, companyName || undefined);
}

function stockReply(stock) {
  const rows = [['SKU', stock.sku]];
  if (stock.name) rows.push(['สินค้า', stock.name]);
  return withVariables(card('📦 ข้อมูลสต๊อกสินค้า', 'เช็กจำนวนพร้อมขายให้แล้วค่ะ', [{ rows }],
    stock.ready > 0 ? 'ยอดพร้อมขาย ณ เวลาที่สอบถามค่ะ' : 'ขณะนี้ยังไม่มีสินค้าพร้อมขายค่ะ',
    `${stock.sku} · พร้อมขาย ${fmt(stock.ready)}`, { label: 'จำนวนพร้อมขาย', value: fmt(stock.ready), warning: stock.ready <= 0 }), { ready: fmt(stock.ready) });
}

function overviewReply(days, offset = 0) {
  const hasPending = days.some(d => d.unpacked || d.awaitingShipment || d.attention);
  const hasUnknown = days.some(d => d.unknown);
  const subtitle = hasPending ? 'ยังมีออเดอร์ที่ต้องดำเนินการค่ะ' :
    hasUnknown ? 'มีบางออเดอร์ที่ยังแยกสถานะไม่ได้ค่ะ' : 'ไม่พบออเดอร์ค้างในสถานะที่ตรวจได้ค่ะ';
  const sections = days.map((day, i) => ({
    heading: `${['วันนี้', 'เมื่อวาน', 'สองวันก่อน'][offset + i]} · ${dateLabel(day.date)}`,
    rows: [
      ['ออเดอร์ทั้งหมด', fmt(day.total)],
      ['ยกเลิก', Number.isInteger(day.cancelled) ? fmt(day.cancelled) : 'ยังตรวจสอบไม่ได้'],
      ['ออเดอร์ใช้งาน', Number.isInteger(day.cancelled) ? fmt(day.total - day.cancelled) : 'ยังตรวจสอบไม่ได้'],
      ['ยังไม่แพ็ค', fmt(day.unpacked), day.unpacked > 0],
      ['แพ็คแล้วรอส่ง', fmt(day.awaitingShipment), day.awaitingShipment > 0],
      ['ปิดงานแล้ว', fmt(day.complete - (day.cancelled || 0))],
      ['มีปัญหา / คืน', fmt(day.attention), day.attention > 0],
      ...(day.unknown ? [['ต้องตรวจเพิ่ม', fmt(day.unknown), true]] : []),
    ],
    detail: 'แต่ละออเดอร์นับในสถานะเดียว ยอดสถานะรวมเท่ากับออเดอร์ใช้งาน',
  }));
  return withVariables(card('📋 ภาพรวมออเดอร์', subtitle, sections, 'ใช้วันที่สั่งซื้อ (OrderDate) ตามเวลาไทย'), {
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
    ['ออเดอร์ตามกำหนดส่งทั้งหมด', fmt(report.scheduled)],
    ['ยกเลิก', fmt(report.cancelled)],
    ['เหลือหลังหักยกเลิก', fmt(report.scheduled - report.cancelled)],
    ['อยู่ระหว่างคืน / คืนแล้ว', fmt(report.returns)],
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
  const note = issuesOnly ? 'กรุณาตรวจสอบออเดอร์ที่ยังแพ็คไม่เสร็จก่อนส่งค่ะ' :
    'เปอร์เซ็นต์แพ็คคำนวณจากออเดอร์ตามกำหนดส่งหลังหักยอดยกเลิกและยอดคืนสินค้า';
  return withVariables(card(issuesOnly ? '⚠️ ออเดอร์ที่ต้องติดตาม' : '🚚 ความคืบหน้าการจัดส่ง', subtitle, sections, note,
    `ต้องส่ง ${fmt(report.due)} · แพ็คแล้ว ${fmt(report.packed)} · ยังไม่เสร็จ ${fmt(report.toPack)}`,
    issuesOnly ? { label: 'ออเดอร์ที่ควรติดตามก่อนส่ง', value: `${fmt(report.toPack + report.unknown)} ออเดอร์`, warning: report.toPack + report.unknown > 0 } :
      { label: 'แพ็คเสร็จ / ออเดอร์ที่ต้องส่ง', value: report.packedPercent === null ? 'ไม่มีออเดอร์ต้องส่ง' : `${fmt(report.packedPercent)}%` }), {
    scheduled: fmt(report.scheduled), cancelled: fmt(report.cancelled), afterCancellation: fmt(report.scheduled - report.cancelled),
    packed: fmt(report.packed), toPack: fmt(report.toPack), unknown: fmt(report.unknown),
  });
}

function dailyShippedReply(report, companyName, notificationTime, assetBase) {
  const date = dateLabel(report.date);
  const rows = [
    ['Shopee', fmt(report.shopee)],
    ['Lazada', fmt(report.lazada)],
    ['TikTok', fmt(report.tiktok)],
    ['Express (B2C)', fmt(report.express)],
    ['B2B', fmt(report.b2b)],
    ...(report.other ? [['อื่น ๆ', fmt(report.other)]] : []),
    ...(report.unknownType ? [['ยังไม่ระบุประเภท', fmt(report.unknownType)]] : []),
  ].filter(([, value]) => value !== '0').map(([label, value]) => [label, value, false,
    { logo: assetBase && ['Shopee', 'Lazada', 'TikTok'].includes(label) ? new URL(`/assets/platforms/${label.toLowerCase()}.png`, assetBase).href : undefined }]);
  if (!rows.length) rows.push(['ยังไม่มีงานจัดส่ง', '—']);
  const detail = report.b2bExpress ? `ยอด B2B รวม Express ${fmt(report.b2bExpress)} ออเดอร์` : undefined;
  const sections = [{ rows, detail }, { rows: [['Total', fmt(report.total)]], emphasis: true }];
  return card(`🚚 สรุปงานที่จัดส่ง ${date}`, companyName, sections,
    `นับออเดอร์ที่สแกนส่งออกครบทุกกล่องถึง ${notificationTime} น. (เวลาไทย)`,
    `${companyName} · ${fmt(report.total)} ออเดอร์`);
}

function shippingFollowUpReply(groups, date, notificationTime, url) {
  const title = '📋 ออเดอร์ที่ยังไม่ได้จัดส่ง';
  const subtitle = `กำหนดส่ง ${dateLabel(date)} · รอบ ${notificationTime} น. (เวลาไทย)`;
  const groupsByType = shippingOrderSections(groups);
  const total = groupsByType.reduce((sum, group) => sum + group.count, 0);
  const sections = groupsByType.map(({ label, stages }) => ({
    heading: label,
    rows: stages.filter(stage => stage.key !== 'unknown' || stage.orders.length)
      .map(({ name, orders }) => [name, fmt(orders.length), orders.length > 0]),
  }));
  const summary = card(title, subtitle, sections, 'สถานะล่าสุดที่ ShipX รายงานในรอบนี้',
    `${dateLabel(date)} · ${fmt(total)} ออเดอร์`, { label: 'ยังไม่ได้จัดส่ง', value: `${fmt(total)} ออเดอร์`, warning: total > 0 });
  if (url && total) {
    summary.message.contents.body.contents.push({
      type: 'button', style: 'primary', color: accent, height: 'sm',
      action: { type: 'uri', label: 'ดูรายการออเดอร์', uri: url },
    });
  }
  return summary;
}

module.exports = { orderReply, stockReply, overviewReply, salesReply, shippingReply, dailyShippedReply, shippingFollowUpReply, stockOverviewReply, handoffReply, card };
