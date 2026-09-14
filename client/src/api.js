const TOKEN_KEY = 'deepmt_token';
const API_BASE_KEY = 'deepmt_api_base';

/**
 * Remote backend base (GitHub Pages mode).
 * - '' (default) = same-origin, for http://localhost:3000 use.
 * - 'https://xxx.trycloudflare.com' = talk to the Mac Mini through the
 *   current tunnel. Set via backend.json (auto-updated by tunnel-rotate.sh),
 *   via ?api=https://... query param, or via localStorage override.
 */
let API_BASE = '';

export function getApiBase() {
  return API_BASE;
}

export function setApiBase(url) {
  API_BASE = (url || '').replace(/\/+$/, '');
  try {
    if (API_BASE) localStorage.setItem(API_BASE_KEY, API_BASE);
    else localStorage.removeItem(API_BASE_KEY);
  } catch { /* private mode */ }
}

/** Prefix a /api/... or /tools-output/... path with the remote backend. */
export function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  if (!API_BASE) return path;
  if (path.startsWith('/')) return API_BASE + path;
  return API_BASE + '/' + path;
}

/** Resolve a backend file URL (/tools-output/...) against the remote backend. */
export function resolveFileUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url)) return url;
  return apiUrl(url);
}

/**
 * Load the backend pointer at startup. Priority:
 *   1. ?api=https://... query param (also persisted to localStorage)
 *   2. localStorage override (set by previous ?api= or settings)
 *   3. ./backend.json shipped with the Pages build (rewritten on each tunnel rotation)
 *   4. '' = same-origin
 */
export async function initApiBase() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = (params.get('api') || '').replace(/\/+$/, '');
    if (q && /^https?:\/\//i.test(q)) {
      setApiBase(q);
      return API_BASE;
    }
  } catch { /* ignore */ }
  try {
    const saved = localStorage.getItem(API_BASE_KEY);
    if (saved && /^https?:\/\//i.test(saved)) {
      API_BASE = saved.replace(/\/+$/, '');
      return API_BASE;
    }
  } catch { /* ignore */ }
  for (const candidate of [`${import.meta.env.BASE_URL}backend.json`, './backend.json', '/backend.json']) {
    try {
      const res = await fetch(candidate, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const base = (data && data.apiBase ? String(data.apiBase) : '').replace(/\/+$/, '');
      if (base && /^https?:\/\//i.test(base)) {
        API_BASE = base;
        return API_BASE;
      }
      if (data && data.apiBase === '') return '';
    } catch { /* try next candidate */ }
  }
  return API_BASE;
}

/** The browser's IANA time zone (e.g. "Europe/Berlin") — sent with each chat
 * stream so tools like get_time can answer in the user's local time. */
export function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function register(username, password) {
  const res = await apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.json();
}

export async function login(username, password) {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.json();
}

export async function fetchMe() {
  const res = await apiFetch('/api/auth/me');
  return res.json();
}

export async function listSessions(q) {
  const res = await apiFetch(q ? `/api/sessions?q=${encodeURIComponent(q)}` : '/api/sessions');
  return res.json();
}

export async function exportSession(sessionId, format) {
  const res = await apiFetch(`/api/sessions/${sessionId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  return res.json();
}

export async function fetchLibrary() {
  const res = await apiFetch('/api/library');
  return res.json();
}

export async function createVariation(url, strength = 0.5) {
  const res = await apiFetch('/api/library/variation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, strength }),
  });
  return res.json();
}

export async function createSession() {
  const res = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.json();
}

export async function renameSession(id, title) {
  const res = await apiFetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

export async function pinSession(id, pinned) {
  const res = await apiFetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  return res.json();
}

/** Rewinds to a user message, replaces its text and returns the trimmed history. */
export async function rewindMessage(sessionId, messageId, content) {
  const res = await apiFetch(`/api/sessions/${sessionId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function deleteSession(id) {
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function listMessages(sessionId) {
  const res = await apiFetch(`/api/sessions/${sessionId}/messages`);
  return res.json();
}

export async function listModels() {
  const res = await apiFetch('/api/chat/models');
  return res.json();
}

export async function fetchTokens() {
  const res = await apiFetch('/api/tokens');
  return res.json();
}

/** The user's HTML archives + current public shares. */
export async function listArchives() {
  const res = await apiFetch('/api/archives');
  return res.json();
}

/** Publish an archive under a custom slug (or auto-derived when omitted). */
export async function shareArchive(file, slug) {
  const res = await apiFetch('/api/archives/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, slug }),
  });
  return res.json();
}

/** Remove a public share. */
export async function unshareArchive(slug) {
  await apiFetch(`/api/archives/share/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}

/** Your API keys (no plaintext). */
export async function listApiKeys() {
  const res = await apiFetch('/api/keys');
  return res.json();
}

/** Create an API key; plaintext is returned exactly once. */
export async function createApiKey(name) {
  const res = await apiFetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

/** Revoke an API key. */
export async function revokeApiKey(id) {
  await apiFetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Streams an assistant reply from /api/chat/stream.
 * Callbacks: onOpen() (SSE established — phase "connecting"), onThinking(model),
 *            onTool({name, args}), onToolResult({name, args, ok, content}),
 *            onToken(token), onProgress({seconds, tokens}), onNotice(message),
 *            onDone({message_id, content, model, usage, tokens}), onError(message).
 * attachments: [{ name, mime, dataUrl }] — optional files/images to attach.
 * rewindMessageId: when set, the server rewrites that user turn in place and
 *                  drops everything after it (an "edit & re-ask").
 * Returns an abort function.
 */
export function streamChat({ sessionId, content, model, attachments, rewindMessageId, onOpen, onThinking, onTool, onToolResult, onToken, onProgress, onNotice, onArchive, onDone, onError }) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
          content,
          model,
          attachments,
          timezone: getBrowserTimezone(),
          rewind_message_id: rewindMessageId,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `Stream failed (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch {
          /* ignore */
        }
        onError(message);
        return;
      }

      if (onOpen) onOpen();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          switch (currentEvent) {
            case 'thinking':
              onThinking(data.model);
              break;
            case 'notice':
              onNotice && onNotice(data.message);
              break;
            case 'progress':
              onProgress && onProgress(data);
              break;
            case 'tool':
              onTool(data);
              break;
            case 'tool_result':
              onToolResult && onToolResult(data);
              break;
            case 'archive':
              onArchive && onArchive(data);
              break;
            case 'token':
              onToken(data.token);
              break;
            case 'done':
              onDone({
                messageId: data.message_id,
                content: data.content,
                model: data.model,
                usage: data.usage,
                tokens: data.tokens,
              });
              return;
            case 'error':
              onError(data.error || 'Stream failed', data.code);
              return;
            default:
              break;
          }
          currentEvent = 'message';
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') onError('Stopped');
      else onError(err.message || 'Connection lost');
    }
  })();

  return () => controller.abort();
}