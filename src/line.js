const { createHmac, timingSafeEqual } = require('node:crypto');
function verifySignature(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest(), supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
class LineClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async reply(replyToken, text) {
    if (this.config.demo) return;
    const response = await this.fetcher('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.lineToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4500) }] }),
      signal: AbortSignal.timeout(7000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`LINE reply HTTP ${response.status}`);
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
}
module.exports = { LineClient, verifySignature };
