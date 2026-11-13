const policy = require('./ai-policy.json');
const { card } = require('./replies');
const { DEFAULT_RESPONSES_URL } = require('./ai-config');
const permutation = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
  new Set(actual).size === actual.length && actual.every(id => expected.includes(id));

function presentationSpec(reply, type) {
  const view = reply.view;
  if (!view || !policy.titles[type]) return null;
  const sections = view.sections.map((section, s) => ({
    id: 's' + s, rows: section.rows.map((_, r) => 's' + s + 'r' + r),
  }));
  const variables = view.variables;
  if (!sections.length || sections.some(section => !section.rows.length)) return null;
  const templates = (policy.responseTemplates[type] || []).filter(template =>
    !/\d/.test(template.replace(/\{\{\w+\}\}/g, '')) &&
    [...template.matchAll(/\{\{(\w+)\}\}/g)].every(([, key]) => Object.hasOwn(variables, key)));
  if (!templates.length) return null;
  // Stage two sees verified totals only. All identifiers, product names, carrier names,
  // free text, company IDs, raw user questions and API payloads stay on this server.
  const facts = Object.fromEntries(Object.entries(variables).map(([key, value]) =>
    [key, key !== 'status' && /^-?\d[\d,.]*$/.test(value) ? value : '[verified value inserted locally]']));
  return { sections, templates, titles: policy.titles[type], facts };
}

function applyPresentation(reply, type, plan) {
  const spec = presentationSpec(reply, type);
  const keys = ['title', 'summaryTemplate', 'density', 'sectionOrder', 'rowOrder'];
  if (!spec || !plan || typeof plan !== 'object' || Object.keys(plan).length !== keys.length ||
      keys.some(key => !Object.hasOwn(plan, key)) || !spec.titles.includes(plan.title) ||
      !spec.templates.includes(plan.summaryTemplate) || !['compact', 'comfortable'].includes(plan.density) ||
      !permutation(plan.sectionOrder, spec.sections.map(s => s.id)) ||
      !permutation(plan.rowOrder, spec.sections.flatMap(s => s.rows))) throw new Error('Invalid AI presentation');
  const view = reply.view;
  const sections = plan.sectionOrder.map(id => {
    const index = spec.sections.findIndex(s => s.id === id), section = view.sections[index];
    const positions = new Map(spec.sections[index].rows.map((row, i) => [row, i]));
    return { ...section, rows: plan.rowOrder.filter(row => positions.has(row)).map(row => section.rows[positions.get(row)]) };
  });
  let summary = plan.summaryTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => String(view.variables[key]));
  if (view.variables.unknown && view.variables.unknown !== '0') summary += ` และยังมี ${view.variables.unknown} ออเดอร์ที่ต้องตรวจสถานะเพิ่มเติมครับ`;
  const result = card(plan.title, view.subtitle, sections, view.note, view.altDetail, view.metric);
  // Preserve all original factual fields and notes. Only the approved summary is added.
  result.message.contents.body.contents.unshift({ type: 'text', text: summary, size: 'sm', color: '#172338', wrap: true });
  result.message.contents.body.spacing = plan.density === 'compact' ? 'sm' : 'md';
  result.text = summary + '\n' + result.text;
  return result;
}

function createPresenter(config, fetcher = fetch) {
  if (config.demo || !config.openaiApiKey || config.aiResponseEnabled === false) return null;
  return async function present(reply, { type, canContinue = () => true } = {}) {
    const spec = presentationSpec(reply, type);
    const fallback = { reply, outcome: 'fallback' };
    if (!spec || !canContinue()) return fallback;
    try {
      const response = await fetcher(config.openaiResponsesUrl || DEFAULT_RESPONSES_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.openaiResponseModel || config.openaiModel, store: false, max_output_tokens: 700,
          instructions: policy.presenterInstructions,
          input: JSON.stringify({ kind: type, facts: spec.facts, sections: spec.sections }),
          text: { format: { type: 'json_schema', name: 'shipx_line_card', strict: true, schema: {
            type: 'object', additionalProperties: false,
            required: ['title', 'summaryTemplate', 'density', 'sectionOrder', 'rowOrder'],
            properties: {
              title: { type: 'string', enum: spec.titles },
              summaryTemplate: { type: 'string', enum: spec.templates },
              density: { type: 'string', enum: ['compact', 'comfortable'] },
              sectionOrder: { type: 'array', items: { type: 'string', enum: spec.sections.map(s => s.id) } },
              rowOrder: { type: 'array', items: { type: 'string', enum: spec.sections.flatMap(s => s.rows) } },
            },
          } } },
        }),
      });
      if (!response.ok || !canContinue()) return fallback;
      const raw = await response.text();
      if (raw.length > 100000) return fallback;
      const json = JSON.parse(raw);
      if (json.status && json.status !== 'completed') return fallback;
      const output = json.output?.find(item => item.type === 'message')?.content?.find(item => item.type === 'output_text');
      if (!output) return fallback;
      return { reply: applyPresentation(reply, type, JSON.parse(output.text)), outcome: 'generated' };
    } catch { return fallback; }
  };
}
module.exports = { createPresenter, presentationSpec, applyPresentation };
