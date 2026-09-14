const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { authRequired, newId } = require('../auth');
const { streamChat, checkHealth, EngineError, providerOnline } = require('../engine');
const { getModel, MODELS } = require('../models');
const { consumeUsage, usageForUser } = require('../usage');
const { recordTokens } = require('../tokens');
const { buildSystemPrompt } = require('../prompt');
const { executeTool, extractToolCall, extractToolCalls, stripToolCalls } = require('../../tools/tools');
const { userDir } = require('../files');
const vision = require('../vision');
const logEvent = require('../events').logEvent;

const router = express.Router();
router.use(authRequired);

const MAX_TOOL_ROUNDS = 3;
const TOOL_PREFIX = '<tool:';
// Keep generation fast: only the most recent turns are sent to the engine,
// and oversized messages are truncated (the 26B engine prefills ~22 tok/s,
// so prompt size directly controls how long the "thinking" phase takes).
const HISTORY_TRIM = 10;
const MESSAGE_TRIM = 1400;
// Tool outputs are mostly useful for their first lines (URLs, short results);
// shrink them so past tool turns don't bloat the next prefill.
const TOOL_RESULT_TRIM = 900;
const PROGRESS_INTERVAL_MS = 900; // faster live updates for mobile “seconds · tokens” (was 2s)

// Math and code need determinism — drop the temperature so the smaller
// engines stop drifting on arithmetic and code generation.
const DETERMINISTIC_RE =
  /(?:^|\s)(?:compute|calculate|solve|evaluate|simplify|derive|factor|integrate|differentiate|sum\s+these|convert\s+\d)|(?:write|fix|debug|explain|review)\s+(?:a\s+)?(?:function|script|program|code)|(?:\d[\d,.]*\s*[-+*/%^]|\bsqrt\s*\(|\bMath\.|=>|\bconst\b|\blet\b|\bvar\b)/i;

function maybeAdjustModel(model, prompt) {
  if (DETERMINISTIC_RE.test(prompt)) {
    return { ...model, temperature: Math.min(model.temperature, 0.2) };
  }
  return model;
}

// The engine serves one generation at a time — track in-flight requests so
// waiters get an honest "you are queued" notice instead of a silent hang.
let runningRequests = 0;

/** Continuation message fed back to the model after a tool executes. */
function toolResultMessage(call, content) {
  const trimmed = String(content || '').trim().slice(0, TOOL_RESULT_TRIM);
  return (
    `[Tool result — ${call.name}]\n${trimmed}\n` +
    'If the user\'s request still needs other tools, emit the next <tool:NAME>{"args"} marker now. ' +
    'Otherwise finish your answer and present the outcome (use the exact URLs the tools returned).'
  );
}

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Accepts an IANA time zone sent by the browser (e.g. "America/New_York").
 * Rejects anything that isn't a real zone, so the tools never crash on junk.
 */
function normalizeTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return tz;
  } catch {
    return null;
  }
}

/** Appends a generated image to the visible message buffer (persisted with
 * the assistant turn and rendered by the client's Markdown component). */
function appendImageToBuffer(bufferHolder, res, url) {
  const link = `\n\n![Generated image](${url})\n`;
  bufferHolder.text += link;
  sseSend(res, 'token', { token: link });
}

function loadHistory(sessionId) {
  return db
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId);
}

/**
 * Persists attachments (images or any file) into the user's own directory.
 * Returns { visible: markdown to embed in the message, described: caption }.
 */
async function saveAttachments(attachments, userId) {
  if (!Array.isArray(attachments)) return { visible: '', described: '' };
  const dir = userDir(userId);
  const visible = [];
  const described = [];
  for (const att of attachments.slice(0, 4)) {
    const name = String(att.name || 'file').trim().slice(0, 80) || 'file';
    const mime = String(att.mime || '');
    const isImage = /^image\//.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name);
    const dataUrl = String(att.dataUrl || '');
    const comma = dataUrl.indexOf(',');
    let ext = path.extname(name).toLowerCase() || (isImage ? '.png' : '.bin');
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = isImage ? '.png' : '.bin';
    let bytes;
    try {
      bytes = Buffer.from(comma === -1 ? dataUrl : dataUrl.slice(comma + 1), 'base64');
    } catch {
      continue;
    }
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) continue;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
    const safeBase = path.basename(name, ext).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40) || 'upload';
    const fileName = `up-${stamp}-${Math.random().toString(36).slice(2, 7)}-${safeBase}${ext}`;
    fs.writeFileSync(path.join(dir, fileName), bytes);
    const url = `/tools-output/${path.basename(dir)}/${fileName}`;
    visible.push(isImage ? `![${safeBase}](${url})` : `[⬇ ${safeBase}](${url})`);
    if (isImage) {
      try {
        const caption = await vision.describeImage(userId, fileName);
        if (caption) described.push(`[Attached image "${safeBase}": ${caption}]`);
      } catch (err) {
        described.push(`[Attached image "${safeBase}" (vision unavailable: ${err.message})]`);
      }
    }
  }
  return { visible: visible.join('\n'), described: described.join('\n') };
}

/**
 * POST /api/chat/stream  { session_id, content, model?, attachments? }
 * attachments: [{ name, mime, dataUrl }] — saved to the user's private
 * directory; images are described with the local vision model and the caption
 * is injected into the user turn so the text model "sees" the picture.
 * SSE events:
 *   thinking -> engine is preparing the first token (client plays the flower animation)
 *   tool     -> { name, args } a tool call was intercepted and is running
 *   token    -> { token } streamed chunks
 *   done     -> { message_id, content, model, usage }
 *   error    -> { error, code? }
 */
router.post('/stream', async (req, res) => {
  const {
    session_id: sessionId,
    content,
    model: modelKey = 'jupiter',
    attachments,
    timezone,
    rewind_message_id: rewindId,
  } = req.body || {};
  const tz = normalizeTimezone(timezone); // browser-reported zone for get_time

  if (!sessionId || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'session_id and content are required' });
  }

  const model = getModel(modelKey);
  if (!model) return res.status(400).json({ error: `Unknown model "${modelKey}". Available: ${Object.keys(MODELS).join(', ')}` });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const usage = consumeUsage(req.user.id, model);
  if (!usage.ok) {
    logEvent('chat', {
      level: 'warn',
      message: `rate-limited on ${model.displayName} (${usage.used}/${usage.limit})`,
      user: req.user.email.split('@')[0],
    });
    return res.status(429).json({
      error: `${model.id} daily limit reached (${usage.used}/${usage.limit}). Try another model or come back tomorrow.`,
      code: 'rate_limited',
      usage,
    });
  }

  const prompt = content.trim();
  let userMessageId = newId();
  const { visible: attachMarkdown, described: attachCaption } = await saveAttachments(attachments, req.user.id);
  const storedContent = attachMarkdown ? `${prompt}\n\n${attachMarkdown}` : prompt;

  // Edit + re-ask: the client re-sends with rewind_message_id set. Rewrite that
  // user row in place and drop everything after it, so no duplicate turn is
  // created (message ids used by the UI stay stable across the re-ask).
  if (rewindId) {
    const target = db
      .prepare('SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = ?')
      .get(String(rewindId), sessionId, 'user');
    if (!target) return res.status(404).json({ error: 'User message not found' });
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(storedContent, target.id);
    db.prepare('DELETE FROM messages WHERE session_id = ? AND created_at > ?').run(sessionId, target.created_at);
    userMessageId = target.id;
  } else {
    db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(userMessageId, sessionId, 'user', storedContent);
  }

  if (session.title === 'New conversation') {
    const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const assistantId = newId();
  let buffer = '';
  const bufferHolder = { get text() { return buffer; }, set text(v) { buffer = v; } };
  let disconnected = false;

  res.on('close', () => {
    if (!res.writableEnded) disconnected = true;
  });

  const fullHistory = loadHistory(sessionId);
  const trimmedHistory = fullHistory.length > HISTORY_TRIM ? fullHistory.slice(fullHistory.length - HISTORY_TRIM) : fullHistory;
  const messages = [
    { role: 'system', content: buildSystemPrompt(model) },
    ...trimmedHistory.map((m) => {
      const isToolResult = m.role === 'user' && String(m.content).startsWith('[Tool result —');
      const max = isToolResult ? TOOL_RESULT_TRIM : MESSAGE_TRIM;
      return {
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: m.content.length > max ? `${m.content.slice(0, max)}\n… (truncated)` : m.content,
      };
    }),
  ];
  // The text engines can't see pixels — inject the vision caption into the
  // user's turn so the model knows what the attached picture shows.
  if (attachCaption && messages.length > 1) {
    const last = messages[messages.length - 1];
    last.content = `${attachCaption}\n${last.content}`;
  }

  sseSend(res, 'thinking', { model: model.id, engine: model.provider, usage: usageForUser(req.user.id) });

  const wasBusy = runningRequests > 0;
  runningRequests++;
  logEvent('chat', {
    message: `generation started (${model.displayName})`,
    model: model.displayName,
    prompt: prompt.slice(0, 90),
    user: req.user.email.split('@')[0],
    queued: wasBusy,
  });
  if (wasBusy) {
    logEvent('engines', { level: 'warn', message: 'engine busy — request queued', model: model.displayName });
    sseSend(res, 'notice', {
      message: 'The engine is busy with another request — you are queued. It will reply as soon as it is free.',
    });
  }

  const startedAt = Date.now();
  let firstTokenSent = false;
  let lastLiveLogAt = 0;
  const progressBeat = setInterval(() => {
    if (disconnected || res.writableEnded) return;
    const chars = messages.reduce((a, m) => a + (m.content || '').length, 0);
    const completion = Math.ceil(buffer.length / 3.5);
    sseSend(res, 'progress', {
      seconds: Math.round((Date.now() - startedAt) / 1000),
      prompt_tokens: Math.round(chars / 3.5),
      completion_tokens: completion,
      tokens: completion,
    });
    // Throttled live-token event so the terminal monitor can show "now" as
    // quickly as the server writes tokens, without flooding the ring buffer.
    const now = Date.now();
    if (now - lastLiveLogAt >= 4000) {
      lastLiveLogAt = now;
      logEvent('tokens', {
        level: 'info',
        message: 'tokens flowing…',
        model: model.displayName,
        prompt_tokens: Math.round(chars / 3.5),
        completion_tokens: completion,
        running: true,
        seconds: Math.round((now - startedAt) / 1000),
      });
    }
  }, PROGRESS_INTERVAL_MS);
  progressBeat.unref?.();

  // Hoisted above the try so the finish paths below can always read them,
  // even when the engine threw before the inner declarations ran.
  let toolsUsed = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let toolSeq = 0; // per-request sequence so the client can match results to cards

  try {
    // If the provider was offline when probed, re-check now — the engine may
    // have come up since the last health poll (no restart required).
    if (!providerOnline(model)) {
      await checkHealth(true);
      if (!providerOnline(model)) throw new EngineError(`${model.id} engine is offline (${model.provider}). Try Lite, or check the engine.`);
    }

    let toolExecuted = false;
    const countedCharsRef = { prompt: 0, completion: 0 };
    const streamModel = maybeAdjustModel(model, prompt);
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      toolExecuted = false;
      const pending = [];

      for await (const chunk of streamChat(streamModel, messages)) {
        if (chunk.usage) {
          // Real token counts straight from the engine when it reports them.
          promptTokens = chunk.usage.prompt_tokens || promptTokens;
          completionTokens = chunk.usage.completion_tokens || completionTokens;
          continue;
        }
        const token = chunk.token;
        if (disconnected) break;
        if (!firstTokenSent) {
          firstTokenSent = true;
          clearInterval(progressBeat);
        }
        pending.push(token);
        const joined = pending.join('');

        const calls = extractToolCalls(joined);
        if (calls.length > 0) {
          const visible = stripToolCalls(joined);
          if (visible) {
            buffer += visible;
            sseSend(res, 'token', { token: visible });
          }
          for (const call of calls) {
            toolSeq++;
            sseSend(res, 'tool', { name: call.name, args: call.args, seq: toolSeq });
            logEvent('tool', { message: `tool ${call.name} invoked`, name: call.name, ok: null });
            const result = await executeTool(call.name, call.args, req.user.id, { timezone: tz });
            logEvent('tool', {
              level: result.ok ? 'info' : 'warn',
              message: `tool ${call.name} ${result.ok ? 'completed' : 'failed'}`,
              name: call.name,
              ok: !!result.ok,
              assetUrl: result.assetUrl || undefined,
            });
            sseSend(res, 'tool_result', {
              name: call.name,
              args: call.args,
              ok: !!result.ok,
              seq: toolSeq,
              content: String(result.content || '').slice(0, 500),
            });
            if (result.siteUrl) {
              sseSend(res, 'archive', { url: result.siteUrl, name: call.name });
            }
            messages.push({ role: 'assistant', content: (visible || '(tool call)').slice(0, MESSAGE_TRIM) });
            // The engines have no native tool protocol wired here, so the result
            // is handed back as a plain user turn carrying the outcome.
            messages.push({ role: 'user', content: toolResultMessage(call, result.content) });
            if (result.imageUrl) appendImageToBuffer(bufferHolder, res, result.imageUrl);
          }
          pending.length = 0;
          toolExecuted = true;
          toolsUsed = true;
          break;
        }

        // Hold back anything that could still become a tool marker:
        //   a) an unclosed <tool: marker anywhere in the text, or
        //   b) a partial prefix of the opening tag at the very end
        //      (e.g. joined ends with "<", "<t", "<to", ..., "<tool:make_cha").
        // The engines stream character-by-character, so a marker is built up
        // over many chunks and must never leak to the client mid-way.
        const stripped = stripToolCalls(joined);
        const lastLt = joined.lastIndexOf('<');
        const tail = lastLt === -1 ? '' : joined.slice(lastLt);
        const partialTool =
          (tail.length <= TOOL_PREFIX.length && TOOL_PREFIX.startsWith(tail)) ||
          /^<tool:\w*$/.test(tail);
        if (stripped.includes(TOOL_PREFIX) || partialTool) continue;

        // Flush all accumulated text.
        pending.length = 0;
        buffer += joined;
        sseSend(res, 'token', { token: joined });
      }

      if (disconnected) break;

      // The stream may end with a complete tool call held back — check the
      // tail before flushing it as plain text.
      const tailBuf = pending.join('');
      if (tailBuf) {
        const tailCalls = extractToolCalls(tailBuf);
        if (tailCalls.length > 0) {
          const visible = stripToolCalls(tailBuf);
          if (visible) {
            buffer += visible;
            sseSend(res, 'token', { token: visible });
          }
          for (const call of tailCalls) {
            toolSeq++;
            sseSend(res, 'tool', { name: call.name, args: call.args, seq: toolSeq });
            logEvent('tool', { message: `tool ${call.name} invoked`, name: call.name, ok: null });
            const result = await executeTool(call.name, call.args, req.user.id, { timezone: tz });
            logEvent('tool', {
              level: result.ok ? 'info' : 'warn',
              message: `tool ${call.name} ${result.ok ? 'completed' : 'failed'}`,
              name: call.name,
              ok: !!result.ok,
              assetUrl: result.assetUrl || undefined,
            });
            sseSend(res, 'tool_result', {
              name: call.name,
              args: call.args,
              ok: !!result.ok,
              seq: toolSeq,
              content: String(result.content || '').slice(0, 500),
            });
            if (result.siteUrl) {
              sseSend(res, 'archive', { url: result.siteUrl, name: call.name });
            }
            messages.push({ role: 'assistant', content: (visible || '(tool call)').slice(0, MESSAGE_TRIM) });
            messages.push({ role: 'user', content: toolResultMessage(call, result.content) });
            if (result.imageUrl) appendImageToBuffer(bufferHolder, res, result.imageUrl);
          }
          pending.length = 0;
          toolExecuted = true;
          toolsUsed = true;
        } else {
          buffer += tailBuf;
          sseSend(res, 'token', { token: tailBuf });
        }
      }

      if (!toolExecuted) break;
    }
  } catch (err) {
    console.error('[chat] stream error:', err.message);
    logEvent('errors', { level: 'error', message: 'chat failed: ' + err.message, model: model.displayName });
    if (!disconnected) {
      sseSend(res, 'error', {
        error: err instanceof EngineError ? err.message : 'Stream failed: ' + err.message,
        code: err instanceof EngineError ? 'engine_offline' : 'stream_failed',
      });
      res.end();
      return;
    }
  } finally {
    clearInterval(progressBeat);
    runningRequests--;
  }

  if (disconnected) {
    if (buffer.trim()) {
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
        .run(assistantId, sessionId, 'ai', buffer);
    }
    // Record whatever we streamed, then close.
    if (promptTokens || completionTokens) {
      recordTokens(req.user.id, model.key, promptTokens, completionTokens);
    }
    res.end();
    return;
  }

  const finalContent = buffer.trim() || (toolsUsed ? '(used tools)' : '');
  db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
    .run(assistantId, sessionId, 'ai', finalContent);

  // Estimate only when the engine didn't report real counts.
  const pt = promptTokens || Math.ceil(messages.reduce((a, m) => a + (m.content || '').length, 0) / 3.5);
  const ct = completionTokens || Math.ceil(finalContent.length / 3.5);
  recordTokens(req.user.id, model.key, pt, ct);
  logEvent('tokens', {
    level: 'info',
    message: `reply finished (${model.displayName})`,
    model: model.displayName,
    prompt_tokens: pt,
    completion_tokens: ct,
    total_tokens: pt + ct,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  });

  sseSend(res, 'done', {
    message_id: assistantId,
    content: finalContent,
    model: model.id,
    usage: usageForUser(req.user.id),
    tokens: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  });
  res.end();
});

/** GET /api/chat/models — available tiers with limits and today's usage. */
router.get('/models', authRequired, async (req, res) => {
  await checkHealth(); // soft re-check (cached 15 s) so tiers unlock without a restart
  const usage = usageForUser(req.user.id);
  const models = Object.values(MODELS).map((m) => ({
    key: m.key,
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    rateLimit: m.rateLimit === Infinity ? null : m.rateLimit, // null = unlimited
    tools: m.tools,
    usedToday: usage[m.key] || 0,
    online: providerOnline(m),
  }));
  res.json({ models });
});

module.exports = router;
