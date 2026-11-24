// ShipX System Design Document, Appendix 15.1 (page 31).
// These are order statuses. Return-document statuses use a different code table.
const statuses = new Map([
  [1001, ['สร้างออเดอร์แล้ว', 'unpacked']],
  [1003, ['รอหยิบสินค้า', 'unpacked']],
  [2001, ['กำลังหยิบสินค้า', 'unpacked']],
  [2002, ['กำลังแพ็คสินค้า', 'unpacked']],
  [2003, ['แพ็คสินค้าเสร็จแล้ว', 'awaitingShipment']],
  [2004, ['พร้อมส่ง รอส่งมอบให้ขนส่ง', 'awaitingShipment']],
  [2005, ['ส่งออกจากคลังแล้ว', 'complete']],
  [4002, ['จัดส่งถึงปลายทางแล้ว', 'complete']],
  [3001, ['ยกเลิกออเดอร์แล้ว', 'complete']],
  [3003, ['ออเดอร์มีปัญหา ต้องตรวจสอบ', 'attention']],
  // V2 DailyReportOrderDetail.isAvailableStock documents 3004 as ProductNotOnhand.
  [3004, ['สินค้าไม่พอสำหรับจัดออเดอร์', 'attention']],
  [5001, ['อยู่ระหว่างคืนสินค้า', 'attention']],
  [5002, ['คืนสินค้าแล้ว', 'complete']],
]);

function orderStatus(value) {
  const code = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  const [label, bucket] = statuses.get(code) || ['ยังระบุความหมายของสถานะนี้ไม่ได้', 'unknown'];
  return { label, bucket };
}

module.exports = { orderStatus };

// Colours follow the supplied ShipX status-filter reference.
const themes = {
  1001: ['#64748B', '#F1F5F9'], 1003: ['#2563EB', '#DBEAFE'],
  2001: ['#6366F1', '#E0E7FF'], 2002: ['#9333EA', '#F3E8FF'],
  2003: ['#854D0E', '#FEF08A'], 2004: ['#0284C7', '#E0F2FE'],
  2005: ['#7C3AED', '#EDE9FE'], 4002: ['#059669', '#D1FAE5'],
  3001: ['#E11D48', '#FFE4E6'], 3003: ['#DB2777', '#FCE7F3'],
  3004: ['#F43F5E', '#FFE4E6'], 5001: ['#EA580C', '#FFEDD5'], 5002: ['#EA580C', '#FFEDD5'],
};
function statusTheme(label) {
  const code = [...statuses].find(([, [name]]) => name === label)?.[0];
  const [color, background] = themes[code] || ['#475569', '#F1F5F9'];
  return { color, background };
}
module.exports.statusTheme = statusTheme;
