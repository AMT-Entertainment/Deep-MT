const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_daily (
    user_id  TEXT NOT NULL,
    model    TEXT NOT NULL,
    day      TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, model, day)
  );
`);

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns { ok, used, limit, remaining } after attempting to consume one
 * request for the user/model today. Infinite limits are never blocked.
 */
function consumeUsage(userId, model) {
  // NOTE: rate limits are temporarily disabled (hobby rollout) — every model
  // is treated as unlimited. Re-enable by using `model.rateLimit` here.
  return { ok: true, used: 0, limit: Infinity, remaining: Infinity };
}

/** Returns today's usage for every model of a user. */
function usageForUser(userId) {
  const rows = db
    .prepare('SELECT model, count FROM usage_daily WHERE user_id = ? AND day = ?')
    .all(userId, today());
  return Object.fromEntries(rows.map((r) => [r.model, r.count]));
}

module.exports = { consumeUsage, usageForUser };
