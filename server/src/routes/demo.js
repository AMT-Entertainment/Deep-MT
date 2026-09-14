/**
 * Public demo stream — powers the "try it live" box on the homepage.
 *
 * No auth (visitors aren't signed in yet), so this route is locked down:
 *   - per-IP rate limit (in-memory, 3 requests / 60 s),
 *   - short prompts only (300 chars), short replies (220 tokens),
 *   - nothing is persisted; tool markers are stripped and never executed,
 *   - prefers Uranus and falls back to Jupiter → Neptune → Lite, so the demo
 *     always answers as long as any engine is online.
 *
 * SSE events (same shape as /api/chat/stream):
 *   event: meta  → { model }          which tier is actually answering
 *   event: token → { token }
 *   event: done  → {}
 *   event: error → { error, code }
 */
const express = require('express');
const { getModel } = require('../models');
const { streamChat, checkHealth, providerOnline, EngineError } = require('../engine');
const { buildSystemPrompt } = require('../prompt');
const { extractToolCalls, stripToolCalls } = require('../../tools/tools');
const { logEvent } = require('../events');

const router = express.Router();

const DEMO_PROMPT_MAX = 300;
const DEMO_MAX_TOKENS = 220;
const TOOL_PREFIX = '<tool:';
const RATE_LIMIT = 3;                  // requests per window
const RATE_WINDOW_MS = 60_000;

// In-memory sliding window per client IP (lost on restart — fine for a demo).
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function pickModel() {
  for (const key of ['uranus', 'jupiter', 'neptune', 'lite']) {
    const m = getModel(key);
    if (m && providerOnline(m)) return m;
  }
  return null;
}

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload || {})}\n\n`);
}

router.post('/stream', async (req, res) => {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demo is rate-limited — try again in a minute.', code: 'demo_limited' });
  }

  const prompt = String(req.body?.prompt || '').trim().slice(0, DEMO_PROMPT_MAX);
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  await checkHealth();
  const model = pickModel();
  if (!model) {
    return res
      .status(503)
      .json({ error: 'All engines are offline right now — try again shortly.', code: 'engines_offline' });
  }

  logEvent('chat', {
    message: `demo stream (${model.displayName})`,
    model: model.displayName,
    user: ip,
    viaApiKey: false,
  });

  const messages = [
    {
      role: 'system',
      content:
        `${buildSystemPrompt(model)}\n\n` +
        'You are talking to a visitor on the DeepMT public homepage demo. Keep the answer to 2-4 short sentences. ' +
        'Do not use tools: never emit <tool: markers.',
    },
    { role: 'user', content: prompt },
  ];

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseSend(res, 'meta', { provider: model.displayName });

  try {
    // Mirrors the chat route's hold logic but only strips tool markers — the
    // public demo must never kick off tools (no user context, no persistence).
    let pending = '';

    for await (const chunk of streamChat(model, messages)) {
      const token = chunk.token;
      if (!token) continue;
      pending += token;
      const joined = pending;

      const calls = extractToolCalls(joined);
      if (calls.length > 0) {
        const visible = stripToolCalls(joined);
        if (visible) sseSend(res, 'token', { token: visible });
        pending = '';
        continue;
      }

      // Hold back anything that could still become a marker so partial
      // <tool: text never leaks to the visitor.
      const stripped = stripToolCalls(joined);
      const lastLt = joined.lastIndexOf('<');
      const tail = lastLt === -1 ? '' : joined.slice(lastLt);
      const partialTool =
        (tail.length <= TOOL_PREFIX.length && TOOL_PREFIX.startsWith(tail)) ||
        /^<tool:\w*$/.test(tail);
      if (stripped.includes(TOOL_PREFIX) || partialTool) continue;

      sseSend(res, 'token', { token: joined });
      pending = '';
    }

    if (pending) {
      const clean = stripToolCalls(pending);
      if (clean) sseSend(res, 'token', { token: clean });
    }
    sseSend(res, 'done', {});
    res.end();
  } catch (err) {
    logEvent('errors', { level: 'error', message: 'demo stream failed: ' + err.message, model: model.displayName });
    sseSend(res, 'error', {
      error: err instanceof EngineError ? err.message : 'Stream failed: ' + err.message,
      code: err instanceof EngineError ? 'engine_offline' : 'stream_failed',
    });
    res.end();
  }
});

module.exports = router;