/**
 * Shared archives — the public "share" layer on top of a user's private
 * tools-output folder.
 *
 * A user can publish any of their generated HTML archives (make_site output)
 * under a custom, globally-unique slug. The public URL is
 *     /u/<username>/shared/archives/<slug>
 * and needs no auth — anyone who has the link can view that one page.
 */
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { userDir } = require('./files');

db.exec(`
  CREATE TABLE IF NOT EXISTS shared_archives (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shared_user ON shared_archives(user_id, created_at DESC);
`);

/** user-set slug: lowercase letters/digits + hyphens, 3–48 chars, alnum start. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;

/** Turns any file name into a safe slug seed (lowercased, hyphenated). */
function slugify(file) {
  return String(path.basename(file))
    .replace(/\.html$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function validateSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/** Finds a page in the user's own folder (must exist on disk). */
function pageExists(userId, file) {
  const safe = String(file || '').replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!/\.html$/i.test(safe)) return null;
  const full = path.join(userDir(userId), safe);
  if (!full.startsWith(path.join(userDir(userId)) + path.sep)) return null;
  try {
    return fs.statSync(full).isFile() ? safe : null;
  } catch {
    return null;
  }
}

function rowToPublic(row) {
  return {
    slug: row.slug,
    file: row.file,
    title: row.title || '',
    public_url: `/u/${encodeURIComponent(row.username)}/shared/archives/${row.slug}`,
    created_at: row.created_at,
  };
}

/**
 * Publishes (or re-publishes) `file` under `slug`. When `slug` is missing it
 * is derived from the file name with a numeric suffix if already taken.
 * Throws `{ message, code: 'slug_taken' | 'invalid_slug' | 'no_file' }`.
 */
function share(u, file, slug) {
  const safeFile = pageExists(u.id, file);
  if (!safeFile) throw Object.assign(new Error('Archive not found on disk'), { code: 'no_file' });

  let finalSlug = typeof slug === 'string' ? slug.trim().toLowerCase().replace(/\s+/g, '-') : '';
  if (validateSlug(finalSlug)) {
    const taken = db.prepare('SELECT id FROM shared_archives WHERE slug = ?').get(finalSlug);
    if (taken && taken.id) {
      throw Object.assign(new Error('That link name is already taken — pick another'), { code: 'slug_taken' });
    }
  } else {
    // Auto-name from the file, appending a counter while the slug is busy.
    const base = slugify(safeFile) || 'archive';
    let n = 0;
    do {
      finalSlug = n === 0 ? base : `${base}-${n}`;
      n++;
    } while (db.prepare('SELECT id FROM shared_archives WHERE slug = ?').get(finalSlug));
  }

  const existing = db
    .prepare('SELECT id FROM shared_archives WHERE user_id = ? AND file = ?')
    .get(u.id, safeFile);
  if (existing) {
    db.prepare('UPDATE shared_archives SET slug = ? WHERE id = ?').run(finalSlug, existing.id);
  } else {
    db.prepare('INSERT INTO shared_archives (id, user_id, file, slug, title) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), u.id, safeFile, finalSlug, String(u.username || ''));
  }

  const row = db
    .prepare(
      `SELECT sa.slug, sa.file, sa.title, sa.created_at, u.username
       FROM shared_archives sa JOIN users u ON u.id = sa.user_id
       WHERE sa.user_id = ? AND sa.file = ?`,
    )
    .get(u.id, safeFile);
  return rowToPublic(row);
}

/** Removes a share a user owns. Returns a boolean. */
function unshareArchive(userId, slug) {
  const res = db.prepare('DELETE FROM shared_archives WHERE user_id = ? AND slug = ?').run(userId, slug);
  return res.changes > 0;
}

/** The user's current shares (for the Archives panel). */
function sharedByUser(userId) {
  return db
    .prepare(
      `SELECT sa.slug, sa.file, sa.title, sa.created_at, u.username
       FROM shared_archives sa JOIN users u ON u.id = sa.user_id
       WHERE sa.user_id = ? ORDER BY sa.created_at DESC`,
    )
    .all(userId)
    .map(rowToPublic);
}

/**
 * Public /u/:username/shared/archives/:slug lookup.
 * Returns { file, userId } or null. No auth required — this is the invite link.
 */
function findPublicShare(rawUsername, slug) {
  if (!validateSlug(slug)) return null;
  const user = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(String(rawUsername || '').toLowerCase());
  if (!user) return null;
  const row = db.prepare('SELECT file FROM shared_archives WHERE user_id = ? AND slug = ?').get(user.id, slug);
  if (!row || !pageExists(user.id, row.file)) return null;
  return { userId: user.id, file: row.file, slug };
}

module.exports = { share, unshareArchive, sharedByUser, findPublicShare, validateSlug, slugify };