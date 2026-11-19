const path = require('node:path');
const { loadAIConfig } = require('./ai-config');
const { shipxAuth } = require('./shipx-auth');
function loadConfig(env, demoFlag = false) {
  const demo = demoFlag || env.SHIPX_MODE === 'demo';
  const production = env.NODE_ENV === 'production';
  if (production && demo) throw new Error('Demo mode is disabled in production.');
  const origin = new URL(env.APP_URL || 'http://localhost:3000').origin;
  if (production && !origin.startsWith('https://')) throw new Error('APP_URL must use HTTPS in production.');
  const password = demo ? 'shipx-demo-local-2026' : env.ADMIN_PASSWORD;
  if (!password || password.length < 16) throw new Error('Set ADMIN_PASSWORD to at least 16 characters, or use npm run demo.');
  if (!demo && (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN)) throw new Error('LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required.');
  let baseUrl = env.SHIPX_BASE_URL?.trim() || '';
  const auth = {
    shipxApiKey: env.SHIPX_API_KEY || '', shipxBearer: env.SHIPX_BEARER_TOKEN || '',
    shipxAuthMode: env.SHIPX_AUTH_MODE || 'auto',
  };
  if (!demo) {
    if (!baseUrl) throw new Error('SHIPX_BASE_URL is required.');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) throw new Error('SHIPX_BASE_URL must contain only the origin or end with /api.');
    if (production && url.protocol !== 'https:') throw new Error('SHIPX_BASE_URL must use HTTPS in production.');
    baseUrl = url.origin;
    if (shipxAuth(auth).mode === 'unconfigured') throw new Error('Configure SHIPX_API_KEY or SHIPX_BEARER_TOKEN.');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const databasePath = path.resolve(demo ? (env.DEMO_DATABASE_PATH || './data/demo.sqlite') : (env.DATABASE_PATH || './data/shipx.sqlite'));
  if (demo && databasePath.toLowerCase() === path.resolve(env.DATABASE_PATH || './data/shipx.sqlite').toLowerCase()) {
    throw new Error('DEMO_DATABASE_PATH must be separate from the live DATABASE_PATH.');
  }
  return {
    demo, production, origin, port, adminUsername: env.ADMIN_USERNAME || 'admin', adminPassword: password,
    databasePath,
    lineSecret: demo ? '' : env.LINE_CHANNEL_SECRET, lineToken: demo ? '' : env.LINE_CHANNEL_ACCESS_TOKEN,
    shipxBaseUrl: baseUrl, ...auth,
    ...loadAIConfig(env, demo),
    shippingDateIsDueDate: env.SHIPX_SHIPPING_DATE_IS_DUE_DATE !== 'false',
  };
}
module.exports = { loadConfig };
