// Offline preview of the actual Flex payloads using demo data.
// LINE's native renderer can differ; also verify the JSON in LINE Flex Simulator.
const { mkdirSync, writeFileSync } = require('node:fs');
const { ShipXClient } = require('../src/shipx');
const { orderReply, stockReply, shippingReply, overviewReply, salesReply, dailyShippedReply, shippingFollowUpReply } = require('../src/replies');
const { shippingReportPage } = require('../src/shipping-report');
const { applyPresentation, presentationSpec } = require('../src/ai-response');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sizes = { xxs:'10px', xs:'12px', sm:'14px', md:'16px', lg:'19px', xl:'22px', xxl:'30px' };
const spacing = { xs:'4px', sm:'8px', md:'14px', lg:'18px' };
function paint(node) {
  if (node.type === 'button') {
    const { label, uri } = node.action;
    const href = uri.startsWith('https://example.test/shipping-orders#') ? 'shipping-orders-preview.html' : uri;
    return `<a class="line-button" href="${escape(href)}">${escape(label)}</a>`;
  }
  const css = [];
  if (node.type === 'text') {
    css.push('min-width:0', 'overflow-wrap:anywhere', 'white-space:pre-wrap', 'font-size:'+(sizes[node.size] || '14px'));
    if (node.weight === 'bold') css.push('font-weight:700');
    if (node.align) css.push('text-align:'+({end:'right',start:'left',center:'center'}[node.align]));
    if (node.gravity === 'center') css.push('align-self:center');
  } else if (node.type === 'box') css.push('display:flex','flex-direction:'+(node.layout==='horizontal'?'row':'column'),'gap:'+(spacing[node.spacing]||'0'));
  for (const [from,to] of Object.entries({color:'color',backgroundColor:'background-color',paddingAll:'padding',paddingTop:'padding-top',paddingBottom:'padding-bottom',paddingStart:'padding-left',paddingEnd:'padding-right',cornerRadius:'border-radius',flex:'flex'})) {
    if (node[from] != null) css.push(to+':'+node[from]);
  }
  if (node.margin) css.push('margin-top:'+(spacing[node.margin]||node.margin));
  return '<div style="'+escape(css.join(';'))+'">'+(node.type==='text' ? escape(node.text) : (node.contents||[]).map(paint).join(''))+'</div>';
}
async function main() {
  const shipx=new ShipXClient({demo:true}), now=new Date('2026-11-05T09:00:00Z');
  const report=await shipx.shippingProgress(101,now);
  let samples=[
    orderReply((await shipx.findOrder(101,'SO001')).order),
    stockReply((await shipx.findStock(101,'SKU001')).stock),
    shippingReply(report),
    shippingReply(report,true,'16:00'),
    overviewReply(await shipx.orderOverview(101,3,now)),
    salesReply(await shipx.salesReport(101,1,now)),
  ];
  const useAIPlan = process.argv.includes('--ai-plan');
  const summaryOnly = process.argv.includes('--shipped-summary');
  if (useAIPlan) samples=samples.map((reply,i)=>{
    const type=['order','stock','shipping','shipping_issues','overview','sales'][i], spec=presentationSpec(reply,type);
    return applyPresentation(reply,type,{
      title:spec.titles[0],summaryTemplate:spec.templates[0],density:'compact',
      sectionOrder:spec.sections.map(s=>s.id),rowOrder:spec.sections.flatMap(s=>s.rows),
    });
  });
  const shippingCutoff = new Date('2026-11-11T18:00:00+07:00');
  const shipped = dailyShippedReply(await shipx.dailyShippedOrders(101, shippingCutoff), 'Ikigai', '18:00');
  const orders = await shipx.shippingFollowUp(101, shippingCutoff);
  const followUp = shippingFollowUpReply(orders, '2026-11-11', '18:00', `https://example.test/shipping-orders#${'1'.repeat(64)}`);
  const messages = [...(summaryOnly ? [] : samples.map(sample => sample.message)), shipped.message, followUp.message];
  const cards=messages.map(message=>{
    const content = [message.contents.header, message.contents.body, message.contents.footer].filter(Boolean).map(paint).join('');
    return '<section><p class="sender">ShipX Bot</p><article>'+content+'</article></section>';
  }).join('');
  const html='<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ShipX LINE Cards Preview</title><style>'
    +'body{margin:0;padding:32px;background:#edf3f9;color:#172338;font-family:Tahoma,Arial,sans-serif;line-height:1.65}main{max-width:1180px;margin:auto}h1{font-size:25px;margin:0}p.lead{color:#667489;margin:6px 0 24px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;align-items:start}.sender{font-size:12px;color:#49627e;margin:0 0 7px 5px}article{background:white;border-radius:16px;overflow:hidden;box-shadow:0 3px 20px #2035520d}section{min-width:0}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:500px){body{padding:18px}.grid{grid-template-columns:1fr}}</style>'
    +'<style>.line-button{display:block;text-align:center;background:#0b62be;color:#fff;border-radius:8px;padding:9px;font-weight:bold;text-decoration:none}</style>'
    +(summaryOnly?'<style>main{max-width:750px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:500px){.grid{grid-template-columns:1fr}}</style>':'')
    +'<main><h1>'+(summaryOnly?'ตัวอย่างการ์ดใน LINE':'ShipX LINE Bot — ตัวอย่างคำตอบ')+'</h1><p class="lead">'+(useAIPlan && !summaryOnly?'แผนการ์ด AI จำลองตาม schema • ไม่ได้เรียกโมเดลจริง • ':'')+(summaryOnly?'ข้อมูลตัวอย่างจาก Flex Message ของแอป':'ข้อมูลจำลองจาก Flex JSON ของแอป • การแสดงผลจริงให้ตรวจใน LINE อีกครั้ง')+'</p><div class="grid">'+cards+'</div></main></html>';
  mkdirSync('artifacts',{recursive:true});
  const prefix='artifacts/'+(summaryOnly?'daily-shipped-preview':useAIPlan?'ai-line-cards-preview':'line-cards-preview');
  writeFileSync(prefix+'.html',html);
  writeFileSync(prefix+'.json',JSON.stringify(messages,null,2));
  writeFileSync('artifacts/shipping-orders-preview.html', shippingReportPage({ companyName: 'Ikigai', day: '2026-11-11', time: '18:00', orders }));
  console.log('Created '+prefix+'.html and .json');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
