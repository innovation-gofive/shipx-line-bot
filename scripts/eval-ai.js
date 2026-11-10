// Explicit --live opts into billable OpenAI calls on synthetic fixtures only.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const cases = require('../test/fixtures/ai-eval.json');
const { interpret, createClassifier } = require('../src/intent');
const { createPresenter, applyPresentation, presentationSpec } = require('../src/ai-response');
const { stockReply } = require('../src/replies');
async function main() {
  const live=process.argv.includes('--live');
  if (live && !process.env.OPENAI_API_KEY) throw Error('Set OPENAI_API_KEY in .env or the current process before using --live. Do not put it in source code.');
  const config={openaiApiKey:process.env.OPENAI_API_KEY,openaiModel:process.env.OPENAI_MODEL||'gpt-4o-mini',openaiResponseModel:process.env.OPENAI_RESPONSE_MODEL||process.env.OPENAI_MODEL||'gpt-4o-mini'};
  const classify=live?createClassifier(config):null;
  const results=[];
  for(const item of cases) {
    let called=false,selected=null,pass=true;
    const actual=await interpret(item.question,classify?async(...args)=>{called=true;selected=await classify(...args);return selected}:null);
    try {assert.deepEqual(actual,item.expected);if(live && item.callAI!==false)assert.equal(selected,item.expected.type);if(item.callAI===false)assert.equal(called,false);} catch {pass=false;}
    results.push({question:item.question,expected:item.expected,actual,pass,calledAI:called});
  }
  const reply=stockReply({sku:'EXAMPLE',name:'Synthetic product',ready:12});
  let presentationPassed=false;
  if(live) presentationPassed=(await createPresenter(config)(reply,{type:'stock'})).outcome==='generated';
  else {
    const spec=presentationSpec(reply,'stock');
    const composed=applyPresentation(reply,'stock',{title:spec.titles[0],summaryTemplate:spec.templates[0],density:'compact',sectionOrder:spec.sections.map(s=>s.id),rowOrder:spec.sections.flatMap(s=>s.rows)});
    presentationPassed=composed.text.includes('12')&&composed.text.includes('EXAMPLE');
  }
  const report={mode:live?'live OpenAI / synthetic data':'offline / no network',cases:results,presentationPassed};
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/ai-eval-report.json',JSON.stringify(report,null,2));
  const passed=results.filter(r=>r.pass).length;
  console.log(report.mode+': '+passed+'/'+results.length+' command cases; presentation '+(presentationPassed?'PASS':'FAIL'));
  if(passed!==results.length||!presentationPassed){console.log('Inspect artifacts/ai-eval-report.json');process.exitCode=1;}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
