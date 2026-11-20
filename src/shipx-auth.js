const modes = new Set(['auto', 'api-key', 'bearer', 'both']);

function shipxAuth(config, { allowMissing = false } = {}) {
  const mode = config.shipxAuthMode || 'auto';
  if (!modes.has(mode)) throw new Error('SHIPX_AUTH_MODE must be auto, api-key, bearer or both.');
  const apiKey = config.shipxApiKey?.trim() || '';
  const bearer = config.shipxBearer?.trim() || '';
  if (mode === 'auto' && !apiKey && !bearer) return { mode: 'unconfigured', headers: {} };
  const selected = mode === 'auto' ? (apiKey ? 'api-key' : 'bearer') : mode;
  if (allowMissing && ((['api-key', 'both'].includes(selected) && !apiKey) || (['bearer', 'both'].includes(selected) && !bearer))) {
    return { mode: 'unconfigured', headers: {} };
  }
  const headers = {};
  if (selected === 'api-key' || selected === 'both') {
    if (!apiKey) throw new Error('SHIPX_API_KEY is required for the selected SHIPX_AUTH_MODE.');
    headers['X-API-Key'] = apiKey;
  }
  if (selected === 'bearer' || selected === 'both') {
    if (!bearer) throw new Error('SHIPX_BEARER_TOKEN is required for the selected SHIPX_AUTH_MODE.');
    headers.Authorization = `Bearer ${bearer}`;
  }
  return { mode: selected, headers };
}

module.exports = { shipxAuth };
