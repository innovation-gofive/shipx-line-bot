const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { shipxAuth } = require('./shipx-auth');
const { serviceError } = require('./service-error');

const AAD = Buffer.from('shipx-bearer-token-v1');
const storageError = () => serviceError('ShipX', 'settings', 'token_storage_unreadable');

function normalizeBearerToken(value) {
  if (typeof value !== 'string' || value.length > 12100) throw Object.assign(new Error('กรุณาวาง Token ของ ShipX ให้ถูกต้อง'), { status: 400 });
  const token = value.trim().replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (!token || token.length > 12000 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw Object.assign(new Error('กรุณาวางเฉพาะ Token หรือ Bearer Token โดยไม่มีช่องว่างภายใน'), { status: 400 });
  }
  return token;
}

// JWT expiry is a display hint. ShipX still validates the actual signature and permissions.
function tokenExpiry(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isSafeInteger(exp) && exp >= 0 && exp <= 8640000000000 ? exp * 1000 : null;
  } catch { return null; }
}

class ShipXTokenStore {
  constructor(config, store, { keyPath, clock = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.keyPath = keyPath || path.join(path.dirname(config.databasePath), 'shipx-token.key');
    this.db.exec(`CREATE TABLE IF NOT EXISTS shipx_credentials (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const { ShipXOAuth } = require('./shipx-oauth');
    this.oauth = new ShipXOAuth(this, { clock });
  }
  row() { return this.db.prepare("SELECT * FROM shipx_credentials WHERE id='bearer'").get(); }
  key(create = false) {
    try {
      let bytes;
      try { bytes = readFileSync(this.keyPath); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        try { writeFileSync(this.keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
        catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
        bytes = readFileSync(this.keyPath);
      }
      if (bytes.length !== 32) throw storageError();
      return bytes;
    } catch { throw storageError(); }
  }
  token() {
    const row = this.row();
    if (!row) return null;
    try {
      const bytes = Buffer.from(row.payload, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return normalizeBearerToken(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { throw storageError(); }
  }
  status() {
    const row = this.row();
    if (!row) return { saved: false, configured: false, source: 'none', updatedAt: null, expiresAt: null, expired: false };
    try {
      const expiresAt = tokenExpiry(this.token());
      return { saved: true, configured: true, source: 'settings', updatedAt: row.updated_at, expiresAt, expired: expiresAt !== null && expiresAt <= this.clock() };
    } catch {
      return { saved: true, configured: false, source: 'settings', updatedAt: row.updated_at, expiresAt: null, expired: false, error: 'token_storage_unreadable' };
    }
  }
  save(value, actor) {
    const token = normalizeBearerToken(value), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
    cipher.setAAD(AAD);
    const bytes = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    this.store.transaction(() => {
      this.db.prepare(`INSERT INTO shipx_credentials VALUES('bearer',?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`).run(payload, this.clock());
      this.store.audit({ actor, action: 'shipx.token.update', outcome: 'success' });
    });
    return this.status();
  }
}

function tokenHealth(status, now = Date.now()) {
  const remainingMs = status.expiresAt === null || status.expiresAt === undefined ? null : status.expiresAt - now;
  const expired = remainingMs !== null && remainingMs <= 0;
  const expiresSoon = remainingMs !== null && remainingMs > 0 && remainingMs <= 86400000;
  const warning = status.error ? 'unreadable' : !status.configured ? 'missing' : expired ? 'expired' : expiresSoon ? 'expiring' : null;
  return { ...status, expired, expiresSoon, remainingMinutes: remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / 60000)), warning };
}
function tokenSettings(config, tokens, now = Date.now()) {
  const automatic = tokens?.oauth?.status();
  if (automatic?.enabled) {
    const configured = automatic.expiresAt !== null;
    const status = tokenHealth({saved:true,configured,source:'automatic',mode:'bearer',apiKeyConfigured:false,bearerConfigured:configured,
      updatedAt:automatic.lastSuccess,expiresAt:automatic.expiresAt,automatic},now);
    return {...status,expiresSoon:false,warning:automatic.lastError?'auto_error':status.expired?'auto_error':null};
  }
  const saved = tokens?.status();
  if (saved?.saved) return tokenHealth({ ...saved, mode: 'bearer', apiKeyConfigured: false, bearerConfigured: saved.configured }, now);
  const auth = shipxAuth(config, { allowMissing: true });
  const usesBearer = auth.mode === 'bearer' || auth.mode === 'both';
  const expiresAt = usesBearer ? tokenExpiry(config.shipxBearer) : null;
  return tokenHealth({
    saved: false, configured: auth.mode !== 'unconfigured', source: auth.mode === 'unconfigured' ? 'none' : 'environment',
    mode: auth.mode, updatedAt: null, expiresAt, expired: expiresAt !== null && expiresAt <= Date.now(),
    apiKeyConfigured: !!auth.headers['X-API-Key'], bearerConfigured: !!auth.headers.Authorization,
  }, now);
}

module.exports = { ShipXTokenStore, tokenSettings, tokenHealth, normalizeBearerToken, tokenExpiry };
