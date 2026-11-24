const { card } = require('./replies');
const choices = [
  { key: 'orders', label: 'มอนิเตอร์ออเดอร์', command: 'ภาพรวมออเดอร์วันนี้', permission: 'report_enabled' },
  { key: 'stock', label: 'ภาพรวมสต็อก', command: 'ภาพรวมสต็อก', permission: 'stock_enabled' },
  { key: 'delivery', label: 'รายงานการจัดส่ง', command: 'รายงานการจัดส่งวันนี้', permission: 'report_enabled' },
  { key: 'reorder', label: 'สินค้าใกล้หมด', command: 'สต็อกไหนถึงจุด reorder', permission: 'stock_enabled' },
  { key: 'packing', label: 'ความคืบหน้าแพ็ค', command: 'วันนี้ต้องส่งกี่ออเดอร์ แพ็คแล้วเท่าไหร่', permission: 'report_enabled' },
];
function addChoices(reply, store, group, keys = ['orders', 'stock', 'delivery']) {
  const enabled = choices.filter(c => keys.includes(c.key) && group[c.permission]);
  const buttons = enabled.map((choice, index) => ({
    type: 'button', style: index === 0 ? 'primary' : 'secondary', ...(index === 0 ? {color:'#172C49'} : {}), height: 'sm', margin: 'sm',
    action: { type: 'postback', label: choice.label, displayText: `ขอดู${choice.label}ค่ะ`, data: store.saveBotAction(group, choice.key) },
  }));
  if (buttons.length) reply.message.contents.footer.contents.unshift(...buttons);
  return reply;
}
function helpReply(store, group, clarification = false) {
  const reply = card('เลือกเรื่องที่อยากดู', clarification ? 'เลือกเรื่องที่อยากให้ Shiny ช่วยได้เลยค่ะ' : 'วันนี้ให้ Shiny ช่วยดูอะไรดีคะ 💛',
    [{ rows: [['ออเดอร์', 'ติดตามสถานะและงานค้าง'], ['สต็อก', 'ยอดพร้อมขายและจุด Reorder'], ['การจัดส่ง', 'ยอดส่งออกและงานรอรถรับ']] }],
    'กดปุ่มด้านล่างเพื่อถามต่อได้เลยค่ะ');
  return addChoices(reply, store, group);
}
const choiceByKey = key => {
  const page = /^reorder:([1-9]\d{0,2})$/.exec(key || '');
  return page ? { ...choices.find(c => c.key === 'reorder'), page: Number(page[1]) } : choices.find(c => c.key === key);
};
function addReorderPage(reply, store, group, page) {
  reply.message.contents.footer.contents.unshift({type:'button',style:'primary',height:'sm',action:{type:'postback',label:'ดู SKU ถัดไป',displayText:'ขอดู SKU ถึงจุด Reorder หน้าถัดไป',data:store.saveBotAction(group,'reorder:'+page)}});
  return reply;
}
module.exports = { helpReply, addChoices, choiceByKey, addReorderPage };
