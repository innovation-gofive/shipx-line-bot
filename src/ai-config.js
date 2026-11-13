const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_RESPONSES_URL = `${DEFAULT_BASE_URL}/responses`;

function loadAIConfig(env, demo = false) {
  const model = env.OPENAI_MODEL || 'gpt-4o-mini';
  let responsesUrl = DEFAULT_RESPONSES_URL;
  if (!demo && env.OPENAI_BASE_URL?.trim()) {
    const base = URL.parse(env.OPENAI_BASE_URL.trim());
    if (base?.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new Error('OPENAI_BASE_URL must be an HTTPS API base URL without credentials, a query, or a fragment.');
    }
    responsesUrl = base.href.replace(/\/+$/, '') + '/responses';
  }
  return {
    openaiApiKey: demo ? '' : (env.OPENAI_API_KEY || ''),
    openaiResponsesUrl: responsesUrl,
    openaiModel: model,
    openaiResponseModel: env.OPENAI_RESPONSE_MODEL || model,
    aiResponseEnabled: env.AI_RESPONSE_ENABLED !== 'false',
  };
}

module.exports = { loadAIConfig, DEFAULT_RESPONSES_URL };
