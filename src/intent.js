const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const policy = require('./ai-policy.json');
const HELP = 'เลือก @ShipX Bot ใน LINE แล้วพิมพ์คำถามได้เลยครับ\n• ออเดอร์ SO001 ให้หน่อย\n• เช็กสต๊อก SKU001\n• วันนี้ต้องส่งกี่ออเดอร์ แพ็คแล้วเท่าไหร่\n• ออเดอร์ที่กำหนดส่งวันนี้แต่ยังแพ็คไม่เสร็จ\n• สรุปออเดอร์ย้อนหลัง 2 วัน\n• รายงานยอดขายวันนี้';
const orderWords = /ออเดอร์|ออร์เดอร์|คำสั่งซื้อ|สถานะ|พัสดุ|ติดตาม|order|tracking|status/i;
const stockWords = /สต(?:๊|็)อก|สต็อค|คงเหลือ|เหลือ\s*(?:เท่าไหร่|เท่าไร|กี่)|พร้อมขาย|\bstock\b|\bsku\b/i;
const salesWords = /ยอดขาย|รายได้|\bsales\b/i;
const summaryWords = /สรุป|รายงาน|ภาพรวม|กี่(?:ออเดอร์|รายการ|งาน)|ค้าง|ยังไม่แพ[็คก]|รอแพ[็คก]|\b(?:overview|report|pending)\b/i;
const shippingWords = /(?:ต้อง|กำหนด|รอ|เตรียม|ครบกำหนด)\s*(?:จัด)?ส่ง|ส่ง\s*(?:วันนี้|เมื่อวาน)|\b(?:due|shipping|dispatch)\b/i;
const issueWords = /ปัญหา|ยังไม่|ยังไม่ได้|ไม่เสร็จ|ค้าง|เตือน|\b(?:issues|problem|unfinished)\b/i;
const unsupportedDates = /สัปดาห์|อาทิตย์|เดือน|ปีนี้|ปีก่อน|ตั้งแต่|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|\b(?:week|month|year)\b/i;
const blocked = /[\r\n=<>?&\\@]|(?:^|\s)\.{1,2}\/|\bcompany(?:\s*ids?|\b)|บริษัทอื่น|\bignore\b/i;
const wordPattern = /[A-Za-z0-9][A-Za-z0-9._/-]*/g;
const english = new Set('order orders status tracking stock sku sales overview report pending today yesterday days day last help check please show for me how many the is of and due shipping dispatch pack packed packing progress issues problem unfinished'.split(' '));
for (const word of policy.extraEnglishVocabulary || []) if (/^[a-z]+$/.test(word)) english.add(word);
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
const thai = new Set([...segmenter.segment('เช็ก เช็ค ตรวจ ตรวจสอบ ดู ขอ ช่วย หา อยาก รู้ อยากรู้ ให้ หน่อย ครับ ค่ะ คะ ได้ ไหม มั้ย หนอ ออเดอร์ ออร์เดอร์ คำสั่งซื้อ เลข รหัส สถานะ สินค้า พัสดุ ติดตาม ถึง ไหน แล้ว หรือ ยัง จัด ส่ง สต็อก สต๊อก สต็อค ของ เหลือ คงเหลือ พร้อมขาย เท่าไหร่ เท่าไร จำนวน สรุป รายงาน ภาพรวม ยอดขาย รายได้ วันนี้ เมื่อวาน เมื่อวานซืน ย้อนหลัง วัน ล่าสุด กี่ รายการ งาน ค้าง รอ แพ็ค แพ็ก แพค หยิบ ไม่ ยังไม่ได้ บ้าง ขาย คลัง วิธีใช้ ช่วยเหลือ ต้อง กำหนด ครบกำหนด เตรียม เสร็จ สำเร็จ ปัญหา เตือน แจ้งเตือน เปอร์เซ็นต์ คิดเป็น แค่ไหน')].map(x => x.segment).filter(x => /^\p{Script=Thai}+$/u.test(x)));
for (const token of segmenter.segment(policy.extraThaiVocabulary || '')) if (/^\p{Script=Thai}+$/u.test(token.segment)) thai.add(token.segment);

function parts(text) {
  const refs = [];
  const safe = text.replace(wordPattern, (word, offset) => {
    const key = word.toLowerCase();
    if (english.has(key)) return ` ${key} `;
    if (/^[23]$/.test(word) && /^\s*(?:วัน|days?\b)/i.test(text.slice(offset + word.length))) return ' ';
    if (!REFERENCE.test(word) || refs.length >= 4) return ' [UNKNOWN] ';
    refs.push(word);
    return ` [REF_${refs.length}] `;
  });
  const tokens = safe.split(/(\[(?:REF_[1-4]|UNKNOWN)\]|[a-z]+|\s+)/g).flatMap(chunk => {
    if (/^\[(?:REF_[1-4]|UNKNOWN)\]$/.test(chunk) || english.has(chunk)) return [chunk];
    return [...segmenter.segment(chunk)].map(x => x.segment).filter(x => thai.has(x));
  });
  return { refs, tokens };
}

function reportPeriod(text) {
  if (unsupportedDates.test(text)) return null;
  const explicit = /(?:ย้อนหลัง|ล่าสุด|last)\s*(\d+)\s*(?:วัน|days?)|(?:ย้อนหลัง|ล่าสุด|last)\s*(\d+)/i.exec(text);
  if (explicit && !['2', '3'].includes(explicit[1] || explicit[2])) return null;
  const today = /วันนี้|\btoday\b/i.test(text), beforeYesterday = /เมื่อวานซืน/i.test(text);
  const yesterday = !beforeYesterday && /เมื่อวาน|\byesterday\b/i.test(text);
  if (/ย้อนหลัง|\blast\b|[23]\s*(?:วัน|days?)/i.test(text) || (today && (yesterday || beforeYesterday))) return { days: 3 };
  if (beforeYesterday || yesterday) return { days: 1, offset: beforeYesterday ? 2 : 1 };
  return { days: today ? 1 : 3 };
}

function route(type, text, refs) {
  if (type === 'order' || type === 'stock') {
    return refs.length === 1 ? { type, reference: refs[0] } : { type: 'help' };
  }
  if (['shipping', 'shipping_issues'].includes(type)) {
    const period = reportPeriod(text);
    if (!period || refs.length || /ย้อนหลัง|\blast\b|[23]\s*(?:วัน|days?)/i.test(text)) return { type: 'help' };
    return { type, days: 1, ...(period.offset ? { offset: period.offset } : {}) };
  }
  if (type === 'overview' || type === 'sales') {
    const period = reportPeriod(text);
    return period && refs.length === 0 ? { type, ...period } : { type: 'help' };
  }
  return { type: 'help' };
}

function parseCommand(text) {
  if (typeof text !== 'string' || text.length > 250) return null;
  const clean = text.trim().replace(/[?!！？。]+$/u, '').trim();
  if (blocked.test(clean)) return null;
  if (/^(help|ช่วยเหลือ|วิธีใช้)$/i.test(clean)) return { type: 'help' };
  const exact = /^(order|status|สถานะ(?:ออเดอร์)?|เช็ค(?:สถานะ)?|stock|สต๊อก|สต็อก)\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,99})$/i.exec(clean);
  if (exact) return route(stockWords.test(exact[1]) ? 'stock' : 'order', clean, [exact[2]]);
  const { refs } = parts(clean);
  if (stockWords.test(clean) && !orderWords.test(clean)) return route('stock', clean, refs);
  if (salesWords.test(clean) && !stockWords.test(clean)) return route('sales', clean, refs);
  if (!refs.length && shippingWords.test(clean)) return route(issueWords.test(clean) ? 'shipping_issues' : 'shipping', clean, refs);
  if (refs.length === 1 && orderWords.test(clean) && !stockWords.test(clean) && !/สรุป|รายงาน|ภาพรวม|\b(?:report|overview)\b/i.test(clean)) return route('order', clean, refs);
  if (summaryWords.test(clean) && !stockWords.test(clean)) return route('overview', clean, refs);
  if (orderWords.test(clean) && !stockWords.test(clean)) return route('order', clean, refs);
  return null;
}

const toolsByType = {
  order: ['lookup_order', 'Read the current status and tracking for one order reference.'],
  stock: ['lookup_sellable_stock', 'Read sellable quantity for one SKU.'],
  overview: ['get_order_overview', 'Read order counts by order creation date, including pending packing statuses.'],
  sales: ['get_sales_report', 'Read sales totals for the requested period.'],
  shipping: ['get_shipping_progress', 'Read orders scheduled for shipping on a date, calculate how many are due, packed, not yet packed, shipped, and percentage packed.'],
  shipping_issues: ['get_shipping_issues', 'Find scheduled-shipping orders that are not packed or have an issue and need attention before shipping.'],
  help: ['show_help', 'Use for unclear, unsupported, or unrelated questions.'],
};
function createClassifier(config, fetcher = fetch) {
  if (config.demo || !config.openaiApiKey) return null;
  return async function classify(tokens, allowedTypes = Object.keys(toolsByType)) {
    const enabled = new Set([...allowedTypes, 'help']);
    const definitions = Object.entries(toolsByType).filter(([type]) => enabled.has(type));
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.openaiModel, store: false, max_output_tokens: 160,
        instructions: policy.plannerInstructions + '\nDomain facts:\n' + JSON.stringify(policy.domainNotes) + '\nExamples:\n' + JSON.stringify(policy.plannerExamples),
        input: tokens.join(' '),
        tools: definitions.map(([, [name, description]]) => ({
          type: 'function', name, description, strict: true,
          parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        })),
        tool_choice: 'required', parallel_tool_calls: false,
      }),
    });
    if (!response.ok) return null;
    const result = await response.json();
    const calls = result.output?.filter(item => item.type === 'function_call');
    if (calls?.length !== 1 || typeof calls[0].arguments !== 'string') return null;
    const args = JSON.parse(calls[0].arguments);
    if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) return null;
    return definitions.find(([, [name]]) => name === calls[0].name)?.[0] || null;
  };
}

async function interpret(text, classify, allowedTypes) {
  const fallback = parseCommand(text);
  if (!classify || typeof text !== 'string' || text.length > 250) return fallback || { type: 'help' };
  text = text.trim().replace(/[?!！？。]+$/u, '').trim();
  if (blocked.test(text)) return fallback || { type: 'help' };
  const { refs, tokens } = parts(text);
  if (tokens.length < 2 || tokens.every(t => t.startsWith('[')) || refs.length > 1) return fallback || { type: 'help' };
  try {
    const type = await classify(tokens, allowedTypes);
    if (Object.hasOwn(toolsByType, type) && type !== 'help' && (type !== 'sales' || salesWords.test(text))) {
      const classified = route(type, text, refs);
      if (classified.type !== 'help') return classified;
    }
  } catch { /* Local commands still work when the classifier is unavailable. */ }
  return fallback || { type: 'help' };
}

module.exports = { REFERENCE, HELP, parseCommand, interpret, createClassifier };
