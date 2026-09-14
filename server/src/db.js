const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || './data/deepmt.db';

if (path.dirname(DB_PATH) !== '.') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    active_status INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'ai')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`);

// Migration: add the display username column (kept out of CREATE TABLE so an
// existing database upgrades in place).
if (!db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name = 'username'").get().n) {
  db.exec("ALTER TABLE users ADD COLUMN username TEXT");
}
db.prepare("UPDATE users SET username = email WHERE username IS NULL OR username = ''").run();

// Migration: pinned conversations float above the rest in the sidebar.
if (!db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sessions') WHERE name = 'pinned'").get().n) {
  db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
}

module.exports = db;
