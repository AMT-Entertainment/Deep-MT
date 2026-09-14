/**
 * API keys — let external programs talk to DeepMT through the OpenAI-compatible
 * /v1 endpoint without a browser login.
 *
 * Keys look like `sk-deepmt-<random>`; only a salted SHA-256 hash is stored, so
 * the plaintext is shown exactly once at creation. A key is scoped to exactly
 * one user (so it inherits that account's daily model limits and billing).
 */
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id, created_at DESC);
`);

const KEY_PREFIX = 'sk-deepmt-';
const SALT = process.env.API_KEY_SALT || 'deepmt-local-key-salt';

function hashKey(plain) {
  return require('node:crypto')
    .createHash('sha256')
    .update(SALT + plain)
    .digest('hex');
}

function newKey() {
  return KEY_PREFIX + randomBytes(28).toString('hex');
}

/** Creates a key and returns { key, created } — key is only ever shown once. */
function createKey(userId, name) {
  const id = randomUUID();
  const plain = newKey();
  const cleanName = String(name || 'Untitled').trim().slice(0, 60) || 'Untitled';
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash) VALUES (?, ?, ?, ?)')
    .run(id, userId, cleanName, hashKey(plain));
  return { id, name: cleanName, key: plain, created_at: new Date().toISOString() };
}

/** Public rows for the management UI — hashes never leave the server. */
function listKeys(userId) {
  return db
    .prepare(
      `SELECT id, name, created_at, last_used_at, revoked
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId);
}

/** Marks a key revoked; returns whether it existed. */
function revokeKey(userId, id) {
  const res = db
    .prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return res.changes > 0;
}

/**
 * Looks up the user behind a plaintext API key. Returns { userId, id } or null.
 * Also bumps last_used_at on success so the UI can show activity.
 */
function findUserByKey(plain) {
  if (!plain || !plain.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare('SELECT id, user_id, revoked FROM api_keys WHERE key_hash = ?')
    .get(hashKey(plain));
  if (!row || row.revoked) return null;
  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(row.id);
  return { keyId: row.id, userId: row.user_id };
}

module.exports = { createKey, listKeys, revokeKey, findUserByKey };