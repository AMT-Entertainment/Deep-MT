/**
 * DeepMT engine gateway — routes a model tier to its provider:
 *
 *   lite    -> Ollama /api/chat (streaming NDJSON) on the LAN host
 *   uranus  -> Ollama /api/chat on this Mac (llama3.1 8B) — dense, fast, tools
 *   neptune -> TurboFieldfare loopback Chat Completions (SSE), reduced budget
 *   jupiter -> TurboFieldfare loopback Chat Completions (SSE), full budget + tools
 */

const { MODELS, OLLAMA_URL, LOCAL_OLLAMA_URL, TF_URL } = require('./models');

const ENGINE_TIMEOUT = Number(process.env.ENGINE_TIMEOUT || 2500);
const DEBUG = process.env.ENGINE_DEBUG === 'true';

const health = { ollama: 'checking', 'ollama-local': 'checking', turbofieldfare: 'checking' };
let lastHealthCheck = 0;
const HEALTH_CACHE_MS = 8_000; // faster unlock when engines come back (was 15s)

function log(...args) {
  if (DEBUG) console.log('[engine]', ...args);
}

/** Re-probes engines, but at most once per HEALTH_CACHE_MS unless forced. */
async function checkHealth(force = false) {
  const now = Date.now();
  if (!force && now - lastHealthCheck < HEALTH_CACHE_MS) return { ...health };
  lastHealthCheck = now;
  await Promise.all([checkOllama(), checkOllamaLocal(), checkTurboFieldfare()]);
  return { ...health };
}

async function checkOllama() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    const ok = res.ok;
    if (ok) {
      const { models } = await res.json();
      const names = models.map((m) => m.name);
      log(`Ollama online (${OLLAMA_URL}): ${names.join(', ')}`);
    }
    setEngineHealth('ollama', ok, { url: OLLAMA_URL });
    return ok;
  } catch {
    clearTimeout(timer);
  }
  setEngineHealth('ollama', false, { url: OLLAMA_URL });
  log(`Ollama not reachable at ${OLLAMA_URL}`);
  return false;
}

async function checkTurboFieldfare() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT);
  try {
    const res = await fetch(`${TF_URL}/../health`, { signal: controller.signal });
    clearTimeout(timer);
    const ok = res.ok;
    log(`TurboFieldfare ${ok ? 'healthy' : 'unhealthy (${res.status})'}`);
    setEngineHealth('turbofieldfare', ok, { url: TF_URL });
    return ok;
  } catch {
    clearTimeout(timer);
    setEngineHealth('turbofieldfare', false, { url: TF_URL });
    log('TurboFieldfare not reachable — Neptune/Jupiter unavailable');
    return false;
  }
}

/** Uranus runs on the Ollama installed on this very Mac (127.0.0.1). */
async function checkOllamaLocal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT);
  try {
    const res = await fetch(`${LOCAL_OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    const ok = res.ok;
    if (ok) {
      const { models } = await res.json();
      const names = (models || []).map((m) => m.name);
      log(`Local Ollama online (${LOCAL_OLLAMA_URL}): ${names.join(', ')}`);
    }
    setEngineHealth('ollama-local', ok, { url: LOCAL_OLLAMA_URL });
    return ok;
  } catch {
    clearTimeout(timer);
    setEngineHealth('ollama-local', false, { url: LOCAL_OLLAMA_URL });
    log(`Local Ollama not reachable at ${LOCAL_OLLAMA_URL} — Uranus unavailable`);
    return false;
  }
}

/** Emits a console event whenever an engine's connectivity state flips. */
function setEngineHealth(engine, online, extra = {}) {
  const prev = health[engine];
  health[engine] = online ? 'online' : 'offline';
  if (prev !== health[engine]) {
    require('./events').logEvent('engines', {
      engine,
      online,
      level: online ? 'info' : 'error',
      message: `${engine} ${online ? 'connected' : 'disconnected'}`,
      ...extra,
    });
  }
}

function getHealth() {
  return { ...health };
}

function providerOnline(model) {
  if (model.provider === 'ollama') return health.ollama === 'online';
  if (model.provider === 'ollama-local') return health['ollama-local'] === 'online';
  return health.turbofieldfare === 'online';
}

/* ------------------------------------------------------------------ */
/* Lite — Ollama streaming chat                                        */
/* ------------------------------------------------------------------ */

/**
 * POSTs a streaming request with a bounded number of retries for transient
 * failures (network errors, 429, 5xx). The 300s timeout restarts each attempt.
 * Returns the fetch Response; the caller must still handle `!res.ok`.
 * Optimized: keep-alive header + shorter backoff for faster live streaming.
 */
async function fetchStream(url, body, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'keep-alive' },
        body: JSON.stringify(body),
        signal: controller.signal,
        // @ts-ignore — Node fetch supports keepalive for connection reuse
        keepalive: true,
      });
      clearTimeout(timer);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      await res.body?.cancel().catch(() => {});
      if (!retryable || attempt >= retries) return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= retries) throw err;
    }
  }
}

/**
 * Stateful transformer that hides a model's private reasoning across stream
 * chunks. Handles:
 *   - SmolLM3:     <think> ... </think>
 *   - Gemma/TF:    a leading run of the literal token "thought"
 * Note: "<" is built from char codes so it survives source mangling.
 */
function makeResponseTransform() {
  const LT = String.fromCharCode(60); // less-than
  const GT = String.fromCharCode(62); // greater-than
  const OPEN_TAG = LT + 'think' + GT;
  const CLOSE_TAG = LT + '/think' + GT;
  let inThink = false;
  let leadingThoughtsDone = false;
  return function transform(raw) {
    let carry = String(raw);
    let out = '';
    while (carry) {
      if (inThink) {
        const close = carry.indexOf(CLOSE_TAG);
        if (close === -1) {
          carry = '';
          continue;
        }
        carry = carry.slice(close + CLOSE_TAG.length);
        inThink = false;
        continue;
      }
      const open = carry.indexOf(OPEN_TAG);
      if (open === -1) {
        // Before any real content, swallow a leading run of "thought".
        if (!leadingThoughtsDone) {
          const m = /^((?:thought\s*)+)/.exec(carry);
          if (m) {
            out += carry.slice(0, m.index);
            carry = carry.slice(m.index + m[0].length);
          }
          leadingThoughtsDone = true;
        }
        out += carry;
        carry = '';
      } else {
        out += carry.slice(0, open);
        carry = carry.slice(open);
        inThink = true;
      }
    }
    return out;
  };
}

async function* streamOllama(model, messages, baseUrl) {
  const transform = makeResponseTransform();
  try {
    const res = await fetchStream(`${baseUrl}/api/chat`, {
      model: model.ollamaModel,
      messages,
      stream: true,
      options: { temperature: model.temperature, num_predict: model.maxTokens },
    });
    if (!res.ok || !res.body) throw new Error(`Ollama responded ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          if (json.done) {
            // Ollama reports real counts on the final chunk.
            if (json.prompt_eval_count != null || json.eval_count != null) {
              yield {
                usage: {
                  prompt_tokens: json.prompt_eval_count || 0,
                  completion_tokens: json.eval_count || 0,
                },
              };
            }
            return;
          }
          if (json.message?.content) yield { token: transform(json.message.content) };
        } catch {
          /* skip malformed line */
        }
      }
    }
  } finally {
    /* fetchStream owns its own timeout; nothing to clear here */
  }
}

/* ------------------------------------------------------------------ */
/* Neptune / Jupiter — TurboFieldfare Chat Completions (SSE)           */
/* ------------------------------------------------------------------ */

async function* streamTurboFieldfare(model, messages) {
  const transform = makeResponseTransform();
  try {
    const res = await fetchStream(`${TF_URL}/chat/completions`, {
      model: model.tfModel,
      messages,
      stream: true,
      max_tokens: model.maxTokens,
      temperature: model.temperature,
      // gemma-4 silently emits hidden reasoning which the response transform
      // has to strip — short-circuit it for faster first tokens on Jupiter.
      thinking: model.thinking ? true : false,
      stream_options: { include_usage: true },
    });
    if (!res.ok || !res.body) throw new Error(`engine responded ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          // Some servers emit a final chunk carrying usage only (no choices).
          if (json.usage && !json.choices?.length) {
            yield {
              usage: {
                prompt_tokens: json.usage.prompt_tokens || 0,
                completion_tokens: json.usage.completion_tokens || 0,
              },
            };
            continue;
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield { token: transform(delta) };
        } catch {
          /* skip malformed chunk */
        }
      }
    }
  } finally {
    /* fetchStream owns its own timeout; nothing to clear here */
  }
}

/**
 * Streams a response for the given model. Yields { token } chunks.
 * Throws EngineError with a user-friendly message when the provider is down.
 */
function streamChat(model, messages) {
  if (model.provider === 'ollama') {
    if (health.ollama !== 'online') {
      throw new EngineError('MT 1.0 Lite is offline — the Ollama host is unreachable.');
    }
    return streamOllama(model, messages, OLLAMA_URL);
  }
  if (model.provider === 'ollama-local') {
    if (health['ollama-local'] !== 'online') {
      throw new EngineError('MT 1.0 Uranus is offline — the local Ollama is not running.');
    }
    return streamOllama(model, messages, LOCAL_OLLAMA_URL);
  }
  if (health.turbofieldfare !== 'online') {
    throw new EngineError('MT 1.0 ' + model.displayName + ' is offline — the local TurboFieldfare engine is not running.');
  }
  return streamTurboFieldfare(model, messages);
}

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

module.exports = { streamChat, checkHealth, getHealth, providerOnline, EngineError };
