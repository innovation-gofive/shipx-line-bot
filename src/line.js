const { createHmac, timingSafeEqual } = require('node:crypto');
const { serviceError } = require('./service-error');
function verifySignature(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest(), supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function addressedCommand(message, destination) {
  if (message?.type !== 'text' || typeof message.text !== 'string' || message.text.length > 450) return null;
  const mentions = message.mention?.mentionees;
  if (!Array.isArray(mentions)) return null;
  const mention = mentions.find(item => item?.type === 'user' && item.isSelf === true && (!destination || item.userId === destination));
  if (!mention ||
      !Number.isInteger(mention.index) || !Number.isInteger(mention.length) || mention.index < 0 || mention.length < 2 ||
      mention.index + mention.length > message.text.length ||
      message.text[mention.index] !== '@') return null;
  const command = (message.text.slice(0, mention.index) + ' ' + message.text.slice(mention.index + mention.length)).trim();
  return command.length <= 250 ? command : null;
}
class LineClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async reply(replyToken, text, message) {
    if (this.config.demo) return;
    const response = await this.fetcher('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.lineToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [message || { type: 'text', text: text.slice(0, 4500).toWellFormed() }] }),
      signal: AbortSignal.timeout(7000), redirect: 'error',
    });
    if (!response.ok) throw serviceError('LINE', '/v2/bot/message/reply', 'request_failed', response.status);
  }
  async groupName(groupId) {
    if (this.config.demo) return '';
    const response = await this.fetcher(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
      headers: { Authorization: `Bearer ${this.config.lineToken}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) return '';
    const data = await response.json();
    return typeof data.groupName === 'string' ? data.groupName.slice(0, 120) : '';
  }
  async push(groupId, message, retryKey) {
    if (this.config.demo) return;
    const messages = Array.isArray(message) ? message : [message];
    const response = await this.fetcher('https://api.line.me/v2/bot/message/push', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
      headers: { Authorization: `Bearer ${this.config.lineToken}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to: groupId, messages }),
    });
    if (response.ok || (response.status === 409 && response.headers.get('x-line-accepted-request-id'))) return;
    throw Object.assign(serviceError('LINE', '/v2/bot/message/push', 'request_failed', response.status), { retryable: response.status >= 500 || response.status === 429 });
  }
}
module.exports = { LineClient, verifySignature, addressedCommand };
