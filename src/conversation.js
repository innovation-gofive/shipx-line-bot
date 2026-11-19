const persona = require('./bot-persona.json');

const USER_ID = /^U[a-f0-9]{32}$/i;
const template = (value, fields) => value.replace(/\{(\w+)\}/g, (_, key) => fields[key] ?? '');

function conversationReply({ text, group, userId, store }) {
  if (typeof text !== 'string') return null;
  const clean = text.trim().replace(/[?!！？。]+$/u, '').trim();
  const canRemember = USER_ID.test(userId || '');
  if (/^(?:ลืมชื่อ(?:ผม|ฉัน|เรา|หนู)?|ลบชื่อ(?:ผม|ฉัน|เรา|หนู)?|forget my name)(?:\s*(?:ให้หน่อย|หน่อย|ด้วย|ครับ|ค่ะ))*$/i.test(clean)) {
    if (canRemember) store.forgetName(group, userId);
    return 'ลบชื่อที่จำไว้สำหรับคุณในกลุ่มนี้แล้วครับ';
  }
  if (/^(?:(?:จำชื่อ(?:ผม|ฉัน|เรา|หนู)?(?:ได้ไหม|ได้มั้ย|ได้หรือเปล่า|ได้ป่ะ)?|(?:ผม|ฉัน|เรา|หนู)\s*ชื่ออะไร)(?:\s*(?:เหรอ|หรอ|นะ|ครับ|ค่ะ))*|what(?:'s| is) my name|remember my name)$/i.test(clean)) {
    const name = canRemember && store.rememberedName(group, userId);
    return name ? template(persona.recallTemplate, { name }) : persona.missingNameReply;
  }
  const naming = /^(?:(?:ผม|ฉัน|เรา|หนู)\s*ชื่อ|เรียก(?:ผม|ฉัน|เรา|หนู)ว่า|my name is|call me)\s*(.+)$/iu.exec(clean);
  if (naming) {
    const name = naming[1].replace(/(?:\s*(?:นะครับ|นะคะ|ครับ|ค่ะ|คับ|นะ))$/u, '').trim();
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u.test(name)) return 'บอกชื่อที่ต้องการให้เรียกสั้น ๆ ได้เลยครับ';
    if (!canRemember) return 'กรุณาบอกชื่อจากบัญชี LINE ของคุณในกลุ่ม เพื่อให้ผมจำชื่อได้ครับ';
    store.rememberName(group, userId, name);
    return template(persona.rememberedTemplate, { name });
  }
  if (/^(?:สวัสดี|หวัดดี|ดีจ้า|hello|hi|hey)(?:\s*(?:ครับ|ค่ะ|คับ|จ้า|บอท))*$/i.test(clean)) {
    const name = canRemember && store.rememberedName(group, userId);
    return template(persona.greetingTemplate, { customer: name ? `คุณ${name}` : '', botName: persona.name });
  }
  if (/^(?:(?:คุณ|บอท|เธอ|นาย|น้อง)\s*)?(?:ชื่อ(?:ว่า)?อะไร|ชื่อไร|เป็นใคร|แนะนำตัว)(?:\s*(?:ครับ|ค่ะ|คะ|หน่อย|ให้หน่อย|ได้ไหม))*$|^who are you$|^what(?:'s| is) your name$/i.test(clean)) {
    return `ผมชื่อ ${persona.name} ${persona.introduction}ครับ`;
  }
  if (/^(?:(?:คุณ|บอท|เธอ|นาย|น้อง)\s*)?อายุ\s*(?:เท่าไหร่|เท่าไร|กี่ปี)(?:\s*(?:แล้ว|ครับ|ค่ะ|คะ|คับ))*$|^how old are you$/i.test(clean)) return persona.ageDescription;
  if (/ทำอะไรได้|ช่วยอะไรได้|ถามอะไรได้|ตอบอะไรได้|รู้(?:เรื่อง)?อะไร|ความสามารถ|what can you do|\bcapabilities\b/i.test(clean)) {
    const capabilities = [];
    if (group.order_enabled) capabilities.push('ตรวจสถานะออเดอร์และเลขพัสดุ');
    if (group.stock_enabled) capabilities.push('เช็กจำนวนพร้อมขายจาก SKU หรือบาร์โค้ด');
    if (group.report_enabled) capabilities.push('สรุปออเดอร์ ยอดยกเลิก ความคืบหน้าแพ็ค งานจัดส่งรายวัน และยอดขาย');
    capabilities.push('จำชื่อที่คุณบอก แนะนำตัว และคุยทักทาย');
    return `ผม ${persona.name} ช่วยได้ตามสิทธิ์ของกลุ่มนี้ครับ\n${capabilities.map(item => `• ${item}`).join('\n')}`;
  }
  return null;
}

module.exports = { conversationReply, persona };
