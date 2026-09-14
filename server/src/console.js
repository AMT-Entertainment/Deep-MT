#!/usr/bin/env node
/**
 * DeepMT — system console (live terminal monitor).
 *
 * Connects to the local DeepMT server as a private "console" user and draws a
 * full-screen dashboard in the terminal: engine connections, chat/tool counts,
 * token usage (live and all-time), and a tail of the event log.
 *
 *   m — toggle between the compact dashboard and a maximized full-screen log
 *   c — clear the on-screen log buffer
 *   q / Ctrl-C — quit (restores the terminal)
 *
 * The window can be resized/maximized like any terminal window; the layout
 * reflows to whatever size you give it. Depends only on node built-ins plus
 * jsonwebtoken + dotenv (both already server deps).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const HOST = String(process.env.DEEPMT_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-deepmt-local-secret';
const CONSOLE_USER = { sub: 'console', email: 'console@local' };

/* ---------------- ANSI helpers ---------------- */
const ESC = '\x1b[';
const fg = (s, rgb) => ESC + '38;2;' + rgb + 'm' + s + ESC + '39m';
const dfg = (s) => ESC + '2m' + s + ESC + '0m';
const bold = (s) => ESC + '1m' + s + ESC + '22m';
const blink = (s) => ESC + '5m' + s + ESC + '25m';

const C = {
  teal: '136,176,168', green: '110,231,183', red: '255,107,107', amber: '246,195,92',
  purple: '167,123,250', cyan: '76,201,240', gray: '140,168,160', dim: '88,116,104',
};

const KIND = {
  system: { label: 'SYS', color: C.gray },
  engines: { label: 'NET', color: C.cyan },
  chat: { label: 'API', color: C.purple },
  http: { label: 'REQ', color: C.cyan },
  tool: { label: 'TOOL', color: C.amber },
  tokens: { label: 'TOK', color: C.green },
  errors: { label: 'ERR', color: C.red },
};

const statusColor = (s) => (s >= 500 ? C.red : s >= 400 ? C.amber : C.green);

/* ---------------- state ---------------- */
const state = {
  start: Date.now(),
  link: 'connecting', // connecting | live | poll | lost
  lastError: null,
  lastId: 0, // highest event id seen, so reconnects/snapshots never double-count
  engines: { ollama: {}, 'ollama-local': {}, turbofieldfare: {}, imagegen: {} },
  counts: { chats: 0, replies: 0, tools: 0, errors: 0, requests: 0 },
  live: { prompt: 0, completion: 0 },
  perModel: {}, // displayName -> { prompt, completion }
  now: { prompt: 0, completion: 0, at: 0 }, // current in-flight request ("now")
  allTime: { prompt: 0, completion: 0, total: 0 },
  log: [],
  mode: 'dash', // dash | log
  last: { w: 0, h: 0 },
};

const pad2 = (n) => String(n).padStart(2, '0');
const uptime = () => {
  const s = Math.floor((Date.now() - state.start) / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const ftime = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');

/* ---------------- event ingestion ---------------- */
function ingest(e) {
  if (!e || !e.kind) return;
  if (e.id) {
    if (e.id <= state.lastId) return; // already seen via a previous snapshot/stream
    state.lastId = e.id;
  }
  if (e.kind === 'engines' && e.engine && e.online != null) {
    state.engines[e.engine] = { online: e.online, at: e.t };
  }
  if (e.kind === 'chat' && /conversation created/.test(e.message || '')) state.counts.chats++;
  if (e.kind === 'http') state.counts.requests++;
  if (e.kind === 'tokens') {
    if (e.running) {
      state.now = { prompt: e.prompt_tokens || 0, completion: e.completion_tokens || 0, at: Date.now() };
    } else {
      state.now = { prompt: e.prompt_tokens || 0, completion: e.completion_tokens || 0, at: Date.now() };
      state.counts.replies++;
      state.live.prompt += e.prompt_tokens || 0;
      state.live.completion += e.completion_tokens || 0;
      if (e.model) {
        const m = (state.perModel[e.model] = state.perModel[e.model] || { prompt: 0, completion: 0 });
        m.prompt += e.prompt_tokens || 0;
        m.completion += e.completion_tokens || 0;
      }
    }
  }
  if (e.kind === 'tool' && e.ok === true) state.counts.tools++;
  if (e.kind === 'errors' || e.level === 'error') state.counts.errors++;

  const meta = KIND[e.kind] || KIND.system;
  const parts = [];
  if (e.model) parts.push(e.model);
  if (e.prompt) parts.push('\u201C' + e.prompt + '\u201D');
  if (e.status) parts.push(e.status + (e.ms != null ? ' \u00B7 ' + e.ms + 'ms' : ''));
  if (e.prompt_tokens != null) parts.push('prm ' + e.prompt_tokens + ' \u00B7 cpl ' + e.completion_tokens);
  if (e.assetUrl) parts.push(e.assetUrl);
  if (e.user) parts.push('u=' + e.user);
  state.log.push({
    t: e.ms || Date.now(), color: meta.color, label: meta.label, status: e.status,
    text: e.message || '', det: parts.filter(Boolean).join('  '),
  });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

function ingestAll(events) {
  for (const e of events) ingest(e);
}

/* ---------------- SSE client ---------------- */
let reconnectTimer = null;
const makeToken = () => jwt.sign(CONSOLE_USER, JWT_SECRET, { expiresIn: '1d' });

async function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  state.link = 'connecting';
  try {
    const res = await fetch(`${HOST}/api/log/stream?token=${encodeURIComponent(makeToken())}`);
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    state.link = 'live';
    state.lastError = null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let evt = 'message';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('event:')) { evt = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const data = JSON.parse(payload);
          if (evt === 'history') ingestAll(data.events);
          else if (evt === 'event') ingest(data.event);
        } catch { /* skip malformed */ }
      }
    }
    throw new Error('stream closed by server');
  } catch (err) {
    state.link = 'lost';
    state.lastError = err instanceof Error && err.message ? err.message : String(err);
  }

  /**
   * Poll-based fallback: if the SSE stream is down (server before #49 or a
   * proxy without streaming), the snapshot endpoint still shows us live.
   * Dedupe by event id means a working stream simply ignores these.
   */
  const snapshot = await fetch(`${HOST}/api/log/events?token=${encodeURIComponent(makeToken())}`).catch(() => null);
  if (snapshot && snapshot.ok) {
    state.link = 'poll';
    try {
      const data = await snapshot.json();
      if (data && data.events) ingestAll(data.events);
    } catch { /* ignore */ }
  }
  reconnectTimer = setTimeout(connect, 3000);
}

async function refreshTotals() {
  try {
    const res = await fetch(`${HOST}/api/tokens`, { headers: { Authorization: 'Bearer ' + makeToken() } });
    if (!res.ok) return;
    const data = await res.json();
    const all = data && data.global && data.global.all;
    if (all) {
      state.allTime = {
        prompt: all.prompt_tokens || 0,
        completion: all.completion_tokens || 0,
        total: all.total_tokens || 0,
      };
    }
  } catch { /* server busy */ }
}

/* ---------------- rendering ---------------- */
const cols = () => Math.max(40, process.stdout.columns || 100);
const rows = () => Math.max(12, process.stdout.rows || 24);
const ru = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));

function engineDot(key) {
  const e = state.engines[key] || {};
  return e.online === true ? fg('●', C.green) : e.online === false ? fg('●', C.red) : fg('●', C.gray);
}

function drawHeader() {
  const w = cols();
  const linkCol =
    state.link === 'live' ? C.green : state.link === 'poll' ? C.teal : state.link === 'lost' ? C.red : C.amber;
  const left = bold(fg('DEEPMT', C.teal)) + dfg(' · ') + fg('SYSTEM MONITOR', C.teal);
  let status = blink(fg('●', linkCol)) + fg(' ' + state.link, C.gray);
  if (state.lastError && state.link !== 'live') status += dfg(' · ' + state.lastError);
  const right =
    fg('up ', C.gray) + fg(uptime(), C.cyan) + '  ' + status + '  ' +
    dfg(state.mode === 'log' ? 'mode MAX' : 'mode dash');
  return [ru(left, w - right.length) + right, dfg('─'.repeat(w))];
}

function enginesPanel() {
  const lines = [fg('CONNECTIONS', C.gray)];
  for (const key of ['ollama', 'ollama-local', 'turbofieldfare', 'imagegen']) {
    const e = state.engines[key] || {};
    const name = ru(key === 'turbofieldfare' ? 'tfengine' : key === 'ollama-local' ? 'local-ollama' : key, 14);
    const st = e.online === true ? fg('online', C.green) : e.online === false ? fg('offline', C.red) : dfg('unknown');
    const last = e.at ? dfg(' · last ' + ftime(new Date(e.at).getTime())) : '';
    lines.push(`  ${engineDot(key)} ${name}${st}${last}`);
  }
  return lines;
}

function statsPanel() {
  const c = state.counts;
  const liveTotal = state.live.prompt + state.live.completion;
  const now = state.now;
  const nowActive = now.at && Date.now() - now.at < 15000;
  const nowRow = nowActive
    ? fg('NOW  ', C.gray) +
      fg(fmtN(now.prompt), C.cyan) + dfg(' prompt') + '  ' +
      fg(fmtN(now.completion), C.green) + dfg(' tokens received') + '  ' +
      blink(dfg('●')) + dfg(' live')
    : fg('NOW  ', C.gray) + dfg('idle — no request in flight');
  return [
    fg('GEN ', C.gray) +
      fg(String(c.chats), C.purple) + dfg(' chats') + '  ' +
      fg(String(c.replies), C.cyan) + dfg(' replies') + '  ' +
      fg(String(c.tools), C.amber) + dfg(' tools') + '  ' +
      fg(String(c.errors), C.red) + dfg(' err') + '  ' +
      fg(String(c.requests), C.teal) + dfg(' api req'),
    nowRow,
    fg('ALL  ', C.gray) +
      fg(fmtN(state.allTime.total), C.green) + dfg(' tokens all-time') +
      dfg('  (' + fmtN(state.allTime.prompt) + ' prompt \u00B7 ' + fmtN(state.allTime.completion) + ' completion)'),
  ];

  const perModel = Object.entries(state.perModel);
  if (perModel.length > 0) {
    const row = perModel
      .sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion))
      .slice(0, 4)
      .map(([name, v]) => {
        const total = v.prompt + v.completion;
        return fg(name.replace(/^MT 1\.0\s*/i, ''), C.cyan) + dfg(` ${fmtN(total)} tok`);
      });
    lines.push(fg('MODS ', C.gray) + row.join('   '));
  }
  return lines;
}

function logPanel(maxRows) {
  const recent = state.log.slice(-maxRows);
  const out = [fg('LOG', C.gray), dfg('─'.repeat(Math.min(cols(), 40)))];
  if (recent.length === 0) out.push(dfg('  waiting for events…'));
  for (const l of recent) {
    const time = ru(fg(ftime(l.t), C.dim), 13);
    const lineColor = l.status ? statusColor(l.status) : l.color;
    const tag = ru(fg(l.label, lineColor), 5);
    const m = (l.status ? fg(String(l.status) + ' ', lineColor) : '') + l.text + (l.det ? dfg('  ' + l.det) : '');
    out.push(' ' + time + ' ' + tag + ' ' + m);
  }
  return out;
}

function drawFrame() {
  const w = cols();
  const h = rows();
  const lines = [];
  lines.push(...drawHeader());

  if (state.mode === 'dash') {
    lines.push(...enginesPanel());
    lines.push('');
    lines.push(...statsPanel());
    lines.push('');
    lines.push(...logPanel(Math.max(8, h - lines.length - 4)));
  } else {
    lines.push(dfg('— maximized log · press m for dashboard —'));
    lines.push(...logPanel(Math.max(10, h - lines.length - 2)));
  }

  lines.push('');
  const footer =
    dfg('  q') + fg(' quit', C.amber) + dfg('  m') + fg(' max', C.amber) +
    dfg('  c') + fg(' clear', C.amber) + '   ' +
    fg(HOST.replace(/^https?:/, ''), C.gray) + dfg(' · ') +
    fg(String(state.log.length), C.gray) + dfg(' events buffered') + '  ' + blink('▊');
  lines.push(footer);

  const sizeChanged = state.last.w !== w || state.last.h !== h;
  state.last = { w, h };
  process.stdout.write(ESC + (sizeChanged ? '2J' : '') + 'H');
  const max = Math.min(lines.length, h);
  for (let i = 0; i < max; i++) process.stdout.write(ESC + 'K' + lines[i] + '\n');
  process.stdout.write(ESC + 'J');
  const parkRow = Math.min(lines.length + 1, h);
  process.stdout.write(ESC + parkRow + ';1H');
}

/* ---------------- keys / lifecycle ---------------- */
function onKey(data) {
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i);
    if (ch === 0x03 || ch === 113 || ch === 81) { finish(); return; } // Ctrl-C / q / Q
    if (ch === 109 || ch === 77) state.mode = state.mode === 'dash' ? 'log' : 'dash'; // m / M
    if (ch === 99 || ch === 67) state.log.length = 0; // c / C
  }
}

function finish() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(ESC + '?25h' + '\nconsole closed. bye\n');
  process.exit(0);
}

function init() {
  process.stdout.on('error', () => {});
  process.stdout.write(ESC + '?25l' + ESC + '2J' + ESC + 'H');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onKey);
  }
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  connect();
  refreshTotals();
  setInterval(refreshTotals, 30000);
  setInterval(() => { try { drawFrame(); } catch { /* terminal gone */ } }, 200);
  drawFrame();
}

init();
