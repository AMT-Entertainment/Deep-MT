/**
 * DeepMT token accounting.
 *
 * Every completed stream records its prompt/completion token counts in an
 * append-only `token_usage` log. Totals are computed by aggregation, so the
 * API can report both the overall (all users) count and one account's count.
 */

const { randomUUID } = require('node:crypto');
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    model             TEXT NOT NULL DEFAULT '',
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_user   ON token_usage(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_token_usage_global ON token_usage(created_at);
`);

/** Records one generation's token counts. Never throws. */
function recordTokens(userId, model, promptTokens, completionTokens) {
  const pt = Math.max(0, Math.round(Number(promptTokens) || 0));
  const ct = Math.max(0, Math.round(Number(completionTokens) || 0));
  if (pt + ct <= 0 || !userId) return null;
  try {
    db.prepare(
      'INSERT INTO token_usage (id, user_id, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), String(userId), String(model || '').slice(0, 40), pt, ct);
  } catch {
    /* accounting must never break a stream */
  }
}

function totals(rows) {
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let total_tokens = 0;
  for (const r of rows || []) {
    prompt_tokens += r.prompt_tokens;
    completion_tokens += r.completion_tokens;
  }
  total_tokens = prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens };
}

/** Global totals (all accounts) + today's global totals. */
function globalSummary() {
  const all = db
    .prepare('SELECT prompt_tokens, completion_tokens FROM token_usage')
    .all();
  const today = db
    .prepare(
      "SELECT prompt_tokens, completion_tokens FROM token_usage WHERE created_at >= date('now')",
    )
    .all();
  return { all: totals(all), today: totals(today) };
}

/** One account's totals + their share of the global total. */
function userSummary(userId) {
  const user = db
    .prepare('SELECT prompt_tokens, completion_tokens FROM token_usage WHERE user_id = ?')
    .all(userId);
  const today = db
    .prepare(
      "SELECT prompt_tokens, completion_tokens FROM token_usage WHERE user_id = ? AND created_at >= date('now')",
    )
    .all(userId);
  const perModel = db
    .prepare(
      'SELECT model, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct FROM token_usage WHERE user_id = ? GROUP BY model',
    )
    .all(userId)
    .map((r) => ({
      model: r.model || 'unknown',
      prompt_tokens: r.pt,
      completion_tokens: r.ct,
    }));
  return { all: totals(user), today: totals(today), perModel };
}

module.exports = { recordTokens, globalSummary, userSummary };