const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELOAD_CHECK_MS = 2000;

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Penyimpanan API key berbasis file JSON. Hanya hash SHA-256 yang disimpan;
// key asli ditampilkan sekali saat dibuat. File dibaca ulang otomatis bila
// berubah (misalnya diubah lewat CLI saat server berjalan).
class KeyStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.keys = [];
    this.byHash = new Map();
    this.mtimeMs = 0;
    this.lastCheck = 0;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
      this.mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.keys = [];
      this.byHash = new Map();
      this.mtimeMs = 0;
      return;
    }
    const data = JSON.parse(raw);
    this.keys = Array.isArray(data.keys) ? data.keys : [];
    this.byHash = new Map(this.keys.map((entry) => [entry.hash, entry]));
  }

  reloadIfChanged() {
    const now = Date.now();
    if (now - this.lastCheck < RELOAD_CHECK_MS) return;
    this.lastCheck = now;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (mtimeMs !== this.mtimeMs) {
      try {
        this.load();
      } catch (error) {
        console.error(`Unable to reload API keys from ${this.filePath}:`, error.message);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ keys: this.keys }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    this.mtimeMs = fs.statSync(this.filePath).mtimeMs;
    this.byHash = new Map(this.keys.map((entry) => [entry.hash, entry]));
  }

  // Mengembalikan entry key yang aktif, atau { revoked: true } / null.
  verify(key) {
    if (typeof key !== 'string' || key.length === 0) return null;
    this.reloadIfChanged();
    const entry = this.byHash.get(hashKey(key));
    if (!entry) return null;
    if (entry.revoked_at) return { revoked: true, entry };
    return { revoked: false, entry };
  }

  create(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Name is required.');
    this.load();
    if (this.keys.some((entry) => !entry.revoked_at && entry.name === trimmed)) {
      throw new Error(`An active key named "${trimmed}" already exists.`);
    }
    const key = `nsfw_${base64url(crypto.randomBytes(32))}`;
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      name: trimmed,
      prefix: key.slice(0, 12),
      hash: hashKey(key),
      created_at: new Date().toISOString(),
      revoked_at: null
    };
    this.keys.push(entry);
    this.save();
    return { key, entry: KeyStore.publicEntry(entry) };
  }

  revoke(idOrName) {
    this.load();
    const entry = this.keys.find((item) => !item.revoked_at && (item.id === idOrName || item.name === idOrName));
    if (!entry) return null;
    entry.revoked_at = new Date().toISOString();
    this.save();
    return KeyStore.publicEntry(entry);
  }

  list() {
    this.reloadIfChanged();
    return this.keys.map(KeyStore.publicEntry);
  }

  static publicEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      prefix: entry.prefix,
      created_at: entry.created_at,
      revoked_at: entry.revoked_at,
      active: !entry.revoked_at
    };
  }
}

module.exports = KeyStore;
