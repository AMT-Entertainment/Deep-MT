/**
 * DeepMT per-account file storage.
 *
 * Every generated asset (image, SVG, chart, PDF, file) lands inside its
 * owner's directory:  tools-output/<userId>/
 * The /tools-output URL space is therefore owned — an authenticated request
 * is only ever resolved against that user's own directory, so nobody can view
 * or download anyone else's generated files.
 *
 * A small `images` table records each generated image (file, prompt, seed) so
 * the API can list a user's own images without scanning the filesystem.
 */
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const OUTPUT_BASE = path.join(__dirname, '..', 'tools-output');
fs.mkdirSync(OUTPUT_BASE, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    prompt     TEXT NOT NULL DEFAULT '',
    seed       INTEGER,
    kind       TEXT NOT NULL DEFAULT 'image',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id, created_at DESC);
`);

/** Sanitizes a user id for use as a directory name (JWT sub is a UUID). */
function sanitizeUserId(userId) {
  const clean = String(userId || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .slice(0, 80);
  return clean || 'unknown';
}

/** Absolute directory that holds a user's generated files. */
function userDir(userId) {
  const dir = path.join(OUTPUT_BASE, sanitizeUserId(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Records a generated image for a user. */
function registerImage(userId, fileName, prompt, seed, kind = 'image') {
  if (!userId || !fileName) return null;
  const row = {
    id: randomUUID(),
    user_id: userId,
    file: fileName,
    prompt: String(prompt || '').slice(0, 1000),
    seed: seed == null ? null : Number(seed),
    kind,
  };
  db.prepare('INSERT INTO images (id, user_id, file, prompt, seed, kind) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.id,
    row.user_id,
    row.file,
    row.prompt,
    row.seed,
    row.kind,
  );
  return row;
}

/** A user's own images, newest first. */
function listUserImages(userId, limit = 60) {
  const rows = db
    .prepare(
      `SELECT file, prompt, seed, kind, created_at FROM images
       WHERE user_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(userId, limit);
  const dir = userDir(userId);
  return rows
    .map((r) => {
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, r.file)).size;
      } catch {
        /* missing on disk — still listed, size 0 */
      }
      return {
        file: r.file,
        url: `/tools-output/${sanitizeUserId(userId)}/${r.file}`,
        size,
        prompt: r.prompt,
        seed: r.seed,
        kind: r.kind,
        created_at: r.created_at,
      };
    });
}

/**
 * Express handler for /tools-output/<userId>/<file>.
 * Resolves every request against the *authenticated* user's own directory
 * only — other users' files return 404. Expects `req.user.id` to be set by
 * the authRequired middleware (which also accepts ?token=<jwt> for <img>).
 */
function serveToolsOutputFile(req, res) {
  const owner = req.user?.id;
  if (!owner) return res.status(401).json({ error: 'Authentication required' });

  const rel = String(req.path || '').replace(/^\/+/, '');
  const parts = rel.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  if (!fileName || /\.\.|[/\\]/.test(fileName) || fileName.length > 120) {
    return res.status(404).json({ error: 'Not found' });
  }

  const dir = userDir(owner);
  const full = path.join(dir, fileName);
  if (!full.startsWith(dir + path.sep)) return res.status(404).json({ error: 'Not found' });

  try {
    if (!fs.statSync(full).isFile()) return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(full);
}

module.exports = { OUTPUT_BASE, userDir, sanitizeUserId, registerImage, listUserImages, serveToolsOutputFile };