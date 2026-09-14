/**
 * OpenAI-compatible API — /v1.
 *
 * Lets any OpenAI SDK or script talk to DeepMT with a Bearer API key
 * (sk-deepmt-…, created at POST /api/keys). Supported:
 *
 *   GET  /v1/models              — list the model tiers
 *   POST /v1/chat/completions    — chat; stream:true (SSE) or false (JSON)
 *
 * The request body follows the OpenAI Chat Completions schema: { model,
 * messages, temperature?, max_tokens?, stream? }. `model` is a tier key
 * ("uranus", "jupiter", …) or a display name ("MT 1.0 Uranus"). Requests count
 * against the owning account's daily limits, and the internal tool pipeline
 * (browser / code / files / images …) still runs under the hood, just like the
 * web chat.
 */
const express = require('express');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { findUserByKey } = require('../apikeys');
const { getModel, listModels } = require('../models');
const { streamChat, checkHealth, providerOnline, EngineError } = require('../engine');
const { consumeUsage } = require('../usage');
const { recordTokens } = require('../tokens');
const { buildSystemPrompt } = require('../prompt');
const { executeTool, extractToolCalls, stripToolCalls } = require('../../tools/tools');
const { logEvent } = require('../events');

const router = express.Router();
router.use(apiAuth);

const MAX_TOOL_ROUNDS = 3;
const TOOL_PREFIX = '<tool:';
const HISTORY_TRIM = 10;
const MESSAGE_TRIM = 1400;
const TOOL_RESULT_TRIM = 900;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-deepmt-local-secret';

/** Authenticates with an API key; a web-session JWT is accepted as a fallback. */
function apiAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <api key>' });

  const found = findUserByKey(token);
  if (found) {
    req.user = { id: found.userId, viaApiKey: true, keyId: found.keyId };
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }
}

function resolveModel(name) {
  if (!name) return getModel('uranus');
  const key = String(name).toLowerCase();
  const byKey = getModel(key);
  if (byKey) return byKey;
  const byId = listModels().find((m) => m.id.toLowerCase() === key);
  return byId ? getModel(byId.key) : null;
}

/** Continuation message handed back to the model after a tool runs. */
function toolResultMessage(call, content) {
  const trimmed = String(content || '').trim().slice(0, TOOL_RESULT_TRIM);
  return (
    `[Tool result — ${call.name}]\n${trimmed}\n` +
    'If the user\'s request still needs other tools, emit the next <tool:NAME>{"args"} marker now. ' +
    'Otherwise finish your answer and present the outcome (use the exact URLs the tools returned).'
  );
}

/** OpenAI clients may send content as a string or as [{type:'text'|'image_url'},…]. */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && part.type === 'text'
            ? part.text || ''
            : '',
      )
      .join('\n');
  }
  return String(content ?? '');
}

async function* runAssistant(model, messages, ctx) {
  let promptTokens = 0;
  let completionTokens = 0;
  let estCompletion = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let toolExecuted = false;
    const pending = [];

    for await (const chunk of streamChat(model, messages)) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || promptTokens;
        completionTokens = chunk.usage.completion_tokens || completionTokens;
        continue;
      }
      const token = chunk.token;
      pending.push(token);
      const joined = pending.join('');

      const calls = extractToolCalls(joined);
      if (calls.length > 0) {
        const visible = stripToolCalls(joined);
        if (visible) { estCompletion += visible.length; yield { token: visible }; }
        for (const call of calls) {
          logEvent('tool', { message: `tool ${call.name} invoked (API)`, name: call.name, ok: null });
          const result = await executeTool(call.name, call.args, ctx.userId, { timezone: ctx.timezone });
          logEvent('tool', {
            level: result.ok ? 'info' : 'warn',
            message: `tool ${call.name} ${result.ok ? 'completed' : 'failed'} (API)`,
            name: call.name,
            ok: !!result.ok,
          });
          if (result.siteUrl) {
            logEvent('tool', {
              message: `API archive created: ${result.siteUrl}`,
              name: call.name,
              ok: true,
            });
            yield { archiveUrl: result.siteUrl };
          }
          if (result.imageUrl) yield { token: `\n\n![Generated image](${result.imageUrl})\n` };
          messages.push({ role: 'assistant', content: (visible || '(tool call)').slice(0, MESSAGE_TRIM) });
          messages.push({ role: 'user', content: toolResultMessage(call, result.content) });
        }
        pending.length = 0;
        toolExecuted = true;
        break;
      }

      // Hold back anything that could still become a tool marker so partial
      // <tool: markers never leak into the visible reply.
      const stripped = stripToolCalls(joined);
      const lastLt = joined.lastIndexOf('<');
      const tail = lastLt === -1 ? '' : joined.slice(lastLt);
      const partialTool =
        (tail.length <= TOOL_PREFIX.length && TOOL_PREFIX.startsWith(tail)) ||
        /^<tool:\w*$/.test(tail);
      if (stripped.includes(TOOL_PREFIX) || partialTool) continue;

      pending.length = 0;
      estCompletion += joined.length;
      yield { token: joined };
    }

    // The stream can end while a complete tool call is still held back.
    const tailBuf = pending.join('');
    if (tailBuf) {
      const tailCalls = extractToolCalls(tailBuf);
      if (tailCalls.length > 0) {
        const visible = stripToolCalls(tailBuf);
        if (visible) { estCompletion += visible.length; yield { token: visible }; }
        for (const call of tailCalls) {
          logEvent('tool', { message: `tool ${call.name} invoked (API)`, name: call.name, ok: null });
          const result = await executeTool(call.name, call.args, ctx.userId, { timezone: ctx.timezone });
          logEvent('tool', {
            level: result.ok ? 'info' : 'warn',
            message: `tool ${call.name} ${result.ok ? 'completed' : 'failed'} (API)`,
            name: call.name,
            ok: !!result.ok,
          });
          if (result.siteUrl) yield { archiveUrl: result.siteUrl };
          if (result.imageUrl) yield { token: `\n\n![Generated image](${result.imageUrl})\n` };
          messages.push({ role: 'assistant', content: (visible || '(tool call)').slice(0, MESSAGE_TRIM) });
          messages.push({ role: 'user', content: toolResultMessage(call, result.content) });
        }
        pending.length = 0;
        toolExecuted = true;
      } else {
        estCompletion += tailBuf.length;
        yield { token: tailBuf };
      }
    }

    if (!toolExecuted) break;
  }

  const pt = promptTokens || Math.ceil(messages.reduce((a, m) => a + (m.content || '').length, 0) / 3.5);
  const ct = completionTokens || Math.ceil(estCompletion / 3.5);
  yield { usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } };
}

router.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: listModels().map((m) => ({
      id: m.id,
      key: m.key,
      object: 'model',
      created: 0,
      owned_by: 'deepmt',
      description: m.description,
    })),
  });
});

router.post('/chat/completions', async (req, res) => {
  const { model: modelName, messages: rawMessages, temperature, max_tokens: maxTokens, stream } = req.body || {};

  const model = resolveModel(modelName);
  if (!model) {
    return res.status(400).json({
      error: `Unknown model "${modelName}". Use one of: ${listModels().map((m) => m.key).join(', ')}`,
    });
  }
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return res.status(400).json({ error: 'messages is required (non-empty array)' });
  }

  // Force a re-probe if the provider looked offline, like the chat route does.
  if (!providerOnline(model)) {
    await checkHealth(true);
    if (!providerOnline(model)) {
      return res.status(503).json({ error: `${model.id} engine is offline (${model.provider}). Check the engine.` });
    }
  }

  const usage = consumeUsage(req.user.id, model);
  if (!usage.ok) {
    return res.status(429).json({
      error: `${model.displayName} daily limit reached (${usage.used}/${usage.limit}). Try another tier.`,
      code: 'rate_limited',
    });
  }

  const messages = rawMessages.slice(-HISTORY_TRIM).map((m, i) => {
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    const content = flattenContent(m.content);
    return { role, content: content.length > MESSAGE_TRIM ? `${content.slice(0, MESSAGE_TRIM)}… (truncated)` : content };
  });
  if (messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: buildSystemPrompt(model) });
  }

  const who = req.user.email ? req.user.email.split('@')[0] : req.user.id.slice(0, 8);
  logEvent('chat', {
    message: `API completion (${model.displayName})`,
    model: model.displayName,
    user: who,
    viaApiKey: !!req.user.viaApiKey,
  });

  const startedAt = Date.now();
  let content = '';
  let finalUsage = null;
  const created = () => Math.floor(Date.now() / 1000);
  const makeId = () => 'chatcmpl-' + randomBytes(6).toString('hex');

  const sendChunk = (delta) => {
    res.write(
      `data: ${JSON.stringify({
        id: makeId(),
        object: 'chat.completion.chunk',
        created: created(),
        model: model.id,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  };

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }

    const cfg = { ...model, temperature: typeof temperature === 'number' ? temperature : model.temperature };
    if (maxTokens) cfg.maxTokens = Math.min(Math.max(1, Number(maxTokens) | 0), 4096);

    for await (const chunk of runAssistant(cfg, messages, { userId: req.user.id, timezone: 'UTC' })) {
      if (chunk.usage) {
        finalUsage = chunk.usage;
        continue;
      }
      if (chunk.archiveUrl) {
        logEvent('tool', { message: `API archive created: ${chunk.archiveUrl}`, name: 'make_site', ok: true });
        continue;
      }
      const token = chunk.token || '';
      if (token) {
        content += token;
        if (stream) sendChunk({ content: token });
      }
    }

    recordTokens(req.user.id, model.key, finalUsage?.prompt_tokens || 0, finalUsage?.completion_tokens || 0);
    logEvent('tokens', {
      level: 'info',
      message: `API reply finished (${model.displayName})`,
      model: model.displayName,
      prompt_tokens: finalUsage?.prompt_tokens || 0,
      completion_tokens: finalUsage?.completion_tokens || 0,
      total_tokens: finalUsage?.total_tokens || 0,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      user: who,
      viaApiKey: !!req.user.viaApiKey,
    });

    if (stream) {
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: makeId(),
        object: 'chat.completion',
        created: created(),
        model: model.id,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (err) {
    logEvent('errors', { level: 'error', message: 'API completion failed: ' + err.message, model: model.displayName });
    if (stream) {
      res.write(`data: ${JSON.stringify({ error: { message: err instanceof EngineError ? err.message : 'Stream failed: ' + err.message } })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err instanceof EngineError ? err.message : 'Stream failed: ' + err.message });
    }
  }
});

module.exports = router;