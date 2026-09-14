const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OLLAMA = 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.DEEPMT_CHAT_MODEL || 'llama3.1:latest';
const VISION_MODEL = process.env.DEEPMT_VISION_MODEL || 'llava:latest';
const DATA_DIR = path.join(os.homedir(), 'DeepMT-Workspace');
const INPUTCTL = path.join(__dirname, 'tools', 'inputctl');

let win = null;
let pendingApprove = null; // {resolve}
let mtStopped = false;
let takeStop = false;
let visionModel = VISION_MODEL;
let chatAbort = null; // AbortController — currently streaming chat reply
let mtAbort = null;   // AbortController — currently generating an [MT] reply
let takeAbort = null; // AbortController — currently waiting on the vision model

/* ---------------- window ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#0a0f0d',
    title: 'DeepMT Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('app:quit', () => app.quit());

/* ---------------- helpers ---------------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function runShell(cmd, cwd, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-lc', cmd], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        exit: err ? (err.code ?? -1) : 0,
        out: String(stdout || '') + (stderr ? '\n' + stderr : ''),
      });
    });
  });
}

async function ollamaTags() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

function pickChat(tags) {
  if (tags.includes(CHAT_MODEL)) return CHAT_MODEL;
  for (const m of tags) if (/^llama3\.1/.test(m)) return m;
  for (const m of tags) if (/^qwen|^mixtral|^gemma/.test(m)) return m;
  return tags[0] || CHAT_MODEL;
}

function pickVision(tags) {
  for (const t of tags) if (/llava|moondream|minicpm|bakllava|lava/i.test(t)) return t;
  return VISION_MODEL;
}

/* ---------------- Ollama chat: streaming ---------------- */

function ollamaChat(messages, model, onDelta, opts) {
  const signal = opts && opts.signal;
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const res = await fetch(`${OLLAMA}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            options: { temperature: 0.5, num_predict: 1600 },
          }),
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let full = '';
        while (true) {
          if (signal && signal.aborted) throw new Error('stopped');
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (j.message && j.message.content) {
                full += j.message.content;
                if (onDelta) onDelta(j.message.content);
              }
            } catch { /* skip */ }
          }
        }
        resolve(full);
      } catch (e) {
        reject(e);
      }
    })();
  });
}

/* ---------------- host TOOLS (used by [MT]) ---------------- */

const TOOLS = {
  shell_exec: {
    desc: 'Run a shell command on the host machine and see stdout/stderr. Args: {"cmd":"one command line"}',
    danger: (c) => {
      const cc = ' ' + String(c || '') + ' ';
      return (
        /\brm\s+-[a-z]*r[a-z]*f?\s+\/\b/.test(cc) ||
        /\b(?:mkfs|mkfs\.\w+|fdisk|dd)\b/.test(cc) ||
        /\b(?:shutdown|reboot|halt|poweroff)\b/.test(cc) ||
        /sudo\s/.test(cc) ||
        /:(){ :\|:& };:/.test(cc)
      );
    },
    run: async ({ cmd }) => {
      const r = await runShell(String(cmd || ''), DATA_DIR, 45000);
      return `[exit ${r.exit}]\n${String(r.out).slice(0, 6000)}`;
    },
  },
  file_read: {
    desc: 'Read a text file. Args: {"path":"/absolute/path"}',
    async run({ path: p }) {
      try {
        const abs = path.resolve(String(p || ''));
        if (!fs.existsSync(abs)) return `[error] no such file: ${abs}`;
        return fs.readFileSync(abs, 'utf8').slice(0, 8000) || '(empty file)';
      } catch (e) {
        return `[error] ${e.message}`;
      }
    },
  },
  file_write: {
    desc: 'Write a text file. Args: {"path":"/abs/path/file.txt","content":"..."} — parent dirs are created. Report the path you wrote.',
    async run({ path: p, content }) {
      try {
        const abs = path.resolve(String(p || ''));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content ?? ''));
        return `[ok] wrote ${abs} (${fs.statSync(abs).size} bytes)`;
      } catch (e) {
        return `[error] ${e.message}`;
      }
    },
  },
  file_list: {
    desc: 'List a directory. Args: {"path":"/absolute/dir"}',
    async run({ path: p }) {
      try {
        const abs = path.resolve(String(p || os.homedir()));
        return fs.readdirSync(abs).slice(0, 500).join('\n');
      } catch (e) {
        return `[error] ${e.message}`;
      }
    },
  },
};

const MT_NAME = new Set(['shell_exec', 'file_read', 'file_write', 'file_list']);

function parseMtCalls(raw) {
  const calls = [];
  const re = /<(?:mt:)?([a-z_]+)>([\s\S]*?)<\/?(?:mt:)?[a-z_]+>|<\s*(mt:)([a-z_]+)>([\s\S]*)$/gm;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1] || m[4] || '';
    if (!MT_NAME.has(name)) continue;
    const body = String(m[2] || m[5] || '').trim();
    let args = {};
    try {
      args = JSON.parse(body);
      if (typeof args !== 'object' || args === null) args = { value: String(args) };
    } catch {
      const kv = {};
      for (const pair of body.replace(/^[({[]|[})\]]$/g, '').split(/,(?=\s*[a-z_]+[\s:=])/)) {
        const pm = /^\s*([a-z_]+)\s*[:=]\s*(.*)$/.exec(pair.trim());
        if (pm) kv[pm[1]] = pm[2].replace(/^["']|["']$/g, '');
      }
      args = kv;
    }
    calls.push({ name, args });
  }
  if (calls.length === 0) {
    // loose single-unclosed marker: <mt:shell_exec>{"cmd":...} with no closing tag
    const m2 = /<(?:mt:)?([a-z_]+)>(\{[\s\S]*?\})(?:<\/?(?:mt:)?[a-z_]+>)?/.exec(raw);
    if (m2 && MT_NAME.has(m2[1])) {
      let args = {};
      try { args = JSON.parse(m2[2]); } catch {}
      calls.push({ name: m2[1], args });
    }
  }
  return calls;
}

/* ---------------- [MT] agent loop ---------------- */

function mtSystem(req) {
  return [
    'You are URANUS[MT], an autonomous agent running directly ON the user\'s real Mac.',
    `Host: ${os.hostname()} (${os.platform()} ${os.arch()}). You drive the machine yourself.`,
    '',
    'Rules:',
    '- Every action goes through exactly one tool, on its own line:',
    '  <mt:shell_exec>{"cmd":"..."}</mt:shell_exec>',
    '  <mt:file_read>{"path":"..."}</mt:file_read>',
    '  <mt:file_write>{"path":"...","content":"..."}</mt:file_write>',
    '  <mt:file_list>{"path":"..."}</mt:file_list>',
    '- Wait for each result, then base the next step on the REAL result only.',
    '- Never guess or fabricate output. Never repeat a failed command blindly.',
    '- Prefer normal userland commands. Do NOT attempt destructive/priviledged ops.',
    '- When done, reply with a concise summary of what you did. No tools in that last message.',
    '',
    `Workspace: ${req.cwd || DATA_DIR}`,
  ].join('\n');
}

function waitForToolResult() {
  return new Promise((resolve) => {
    pendingApprove = { resolve };
  });
}

async function runMtGoal(req) {
  const model = req.model || CHAT_MODEL;
  const goal = String(req.goal || '');
  const auto = req.autoApprove === true;
  if (!goal.trim()) return send('mt:end', { ok: false, error: 'No goal given.' });
  mtStopped = false;
  if (mtAbort) { try { mtAbort.abort(); } catch {} }
  const ctrl = new AbortController();
  mtAbort = ctrl;

  const messages = [
    { role: 'system', content: mtSystem(req) },
    { role: 'user', content: `GOAL: ${goal}` },
  ];
  let turns = 0;
  let last = '';
  let toolCalls = 0;
  let repeatStreak = 0;
  let lastCallKey = '';

  send('mt:event', { kind: 'start', text: `[MT] start — "${goal}"`, at: Date.now() });

  while (mtStopped === false && turns++ < 40) {
    let reply = '';
    try {
      reply = await ollamaChat(messages, model, (d) => send('mt:event', { kind: 'assistant', delta: d }), { signal: ctrl.signal });
    } catch (e) {
      if (/stopped/.test(String(e.message || ''))) return send('mt:end', { stopped: true });
      return send('mt:end', { ok: false, error: e.message });
    }
    last = reply;
    const calls = parseMtCalls(reply);

    // strip everything after the first marker (drop confabulated "output")
    const first = reply.indexOf('<mt:');
    const kept = first === -1 ? reply : reply.slice(0, Math.max(0, first)).trim() || '(tool call)';
    messages.push({ role: 'assistant', content: kept });

    if (calls.length === 0) {
      if (turns === 1) {
        messages.push({ role: 'user', content: 'No tool marker found. You MUST drive the machine with a tool. If the current message already completes the goal, restate it as a summary.' });
        continue;
      }
      // settle: treat as final summary
      break;
    }

    if (calls.length > 1) {
      messages.push({ role: 'user', content: `HARD RULE: you emitted ${calls.length} markers; only the first was executed. One tool per reply.` });
    }
    const call = calls[0];
    const tool = TOOLS[call.name];

    // Per-run safety: cap tool executions and stop when the agent repeats
    // the exact same call over and over without making progress.
    if (++toolCalls > 15) {
      return send('mt:end', { ok: false, reason: 'tool cap reached (15 calls)' });
    }
    const key = `${call.name} ${JSON.stringify(call.args)}`;
    repeatStreak = key === lastCallKey ? repeatStreak + 1 : 1;
    lastCallKey = key;
    if (repeatStreak >= 3) {
      return send('mt:end', { ok: false, reason: `repeating the same action: ${key.slice(0, 80)}` });
    }

    send('mt:event', { kind: 'tool', name: call.name, args: call.args, at: Date.now() });

    const dangerous = tool.danger && tool.danger(call.args.cmd);
    let content;
    if (dangerous) {
      content = '[blocked] that command is destructive/privileged. Use a safe equivalent.';
    } else {
      send('mt:event', { kind: 'approve', name: call.name, args: call.args, auto, at: Date.now() });
      if (!auto) {
        const res = await waitForToolResult();
        if (mtStopped) return send('mt:end', { stopped: true });
        if (res.allow === false) {
          content = '[declined by user] pick a different approach.';
        } else {
          try { content = await (tool.run(call.args)); }
          catch (e) { content = `[tool error] ${e.message}`; }
        }
      } else {
        try { content = await (tool.run(call.args)); }
        catch (e) { content = `[tool error] ${e.message}`; }
      }
    }
    send('mt:event', { kind: 'result', name: call.name, text: String(content).slice(0, 1200), at: Date.now() });
    messages.push({ role: 'user', content: `Tool result:\n${content}` });
  }

  if (mtStopped) return send('mt:end', { stopped: true });

  let final = '';
  try {
    final = await ollamaChat(
      [...messages, { role: 'user', content: 'Write the final summary of what you did. No tools.' }],
      model,
      (d) => send('mt:event', { kind: 'final', delta: d }),
      { signal: ctrl.signal },
    );
  } catch (e) {
    if (/stopped/.test(String(e.message || ''))) return send('mt:end', { stopped: true });
    final = last;
  }
  if (mtStopped) return send('mt:end', { stopped: true });
  send('mt:end', { ok: true, turns, final: String(final).slice(0, 3000) });
}

ipcMain.on('mt:goal', (_e, req) => {
  send('mt:all-start', {});
  runMtGoal(req || {});
});

ipcMain.on('mt:approve', (_e, allow) => {
  if (pendingApprove) { pendingApprove.resolve({ allow: !!allow }); pendingApprove = null; }
});

ipcMain.on('take:approve', (_e, allow) => {
  if (pendingApprove) { pendingApprove.resolve({ allow: !!allow }); pendingApprove = null; }
});

ipcMain.on('mt:stop', () => {
  mtStopped = true;
  if (mtAbort) { try { mtAbort.abort(); } catch {} }
  if (pendingApprove) { pendingApprove.resolve({ allow: false }); pendingApprove = null; }
});

ipcMain.on('ollama:tags', async (e) => {
  const tags = await ollamaTags();
  visionModel = pickVision(tags);
  e.sender.send('ollama:tags:result', {
    tags,
    chat: pickChat(tags),
    vision: visionModel,
    ollamaUp: tags.length > 0,
  });
});

ipcMain.on('chat:send', (_e, { messages, model }) => {
  if (chatAbort) { try { chatAbort.abort(); } catch {} }
  const ctrl = new AbortController();
  chatAbort = ctrl;
  (async () => {
    try {
      await ollamaChat(messages, model || CHAT_MODEL, (d) => send('chat:delta', { delta: d }), { signal: ctrl.signal });
      send('chat:end', { ok: true });
    } catch (err) {
      const stopped = ctrl.signal.aborted || err.name === 'AbortError' || /stopped|aborted/i.test(String(err.message || ''));
      send('chat:end', { ok: false, error: 'stopped', stopped });
    } finally {
      if (chatAbort === ctrl) chatAbort = null;
    }
  })();
});

ipcMain.on('chat:delta:stop', () => { if (chatAbort) { try { chatAbort.abort(); } catch {} } });

/* ---------------- TAKE OVER (vision computer-use) ---------------- */

function captScreen() {
  return new Promise(async (resolve, reject) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1600, height: 1000 },
        fetchWindowIcons: false,
      });
      const src = sources.find((s) => s.screenId === '0') || sources[0];
      if (!src) return reject(new Error('no screen source'));
      if (!src.thumbnail || src.thumbnail.isEmpty())
        return reject(new Error('empty capture — grant Screen Recording in System Settings › Privacy & Security'));
      const png = src.thumbnail.toPNG();
      const sz = src.thumbnail.getSize();
      // Map the thumbnail's pixel space onto the real display (points).
      const disp =
        screen.getAllDisplays().find((d) => String(d.id) === String(src.screen_id)) ||
        screen.getPrimaryDisplay();
      const b = disp.bounds;
      resolve({ b64: png.toString('base64'), w: sz.width, h: sz.height, bx: b.x, by: b.y, bw: b.width, bh: b.height });
    } catch (e) {
      reject(e);
    }
  });
}

// vision-model coords live in the captured thumbnail's pixel space;
// this maps them to real display coordinates. macOS CGEvent click points.
function mapToScreen(act, shot) {
  if (act.act !== 'click' || !shot || !shot.w || !shot.h) return act;
  const x = Math.round(shot.bx + (Number(act.x) / shot.w) * shot.bw);
  const y = Math.round(shot.by + (Number(act.y) / shot.h) * shot.bh);
  return { ...act, x: Math.max(0, Math.min(shot.bx + shot.bw, x)), y: Math.max(0, Math.min(shot.by + shot.bh, y)) };
}

async function visionAction(imageB64, goal, context, signal, repeatHint) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: visionModel,
        prompt: [
          `You are controlling a Mac via mouse/keyboard. GOAL: ${goal}`,
          context ? `RECENT ACTIONS: ${context}` : '',
          repeatHint ? `WARNING: you just did ${repeatHint} and nothing changed. Pick a DIFFERENT target this time.` : '',
          'Look at this screenshot and choose the next action. Return ONLY a single JSON object, no prose. Options:',
          '{"act":"click","x":<px>,"y":<px>,"why":"..."}',
          '{"act":"type","text":"...","why":"..."}',
          '{"act":"key","keys":"cmd+space","why":"..."}',
          '{"act":"scroll","ticks":-3,"why":"..."}',
          '{"act":"done","why":"goal achieved"}',
        ].filter(Boolean).join('\n'),
        images: [imageB64],
        stream: false,
        options: { temperature: 0.1, num_predict: 200 },
      }),
    });
  } catch (e) {
    if (signal && signal.aborted) throw new Error('stopped');
    throw e;
  }
  if (!res.ok) throw new Error(`vision ${res.status}`);
  const j = await res.json();
  const text = String(j.response || '');
  const re = /\{[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { return JSON.parse(m[0]); } catch { /* try next brace-group */ }
  }
  return { act: 'done', why: `unreadable vision reply: ${text.slice(0, 120)}` };
}

function injectInput(action) {
  const argv = actArgv(action);
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

function actArgv(act) {
  // Actions are executed by tools/inputctl (a tiny Swift CGEvent controller)
  // for mouse / keyboard / scrolling. No osascript dependency.
  if (!act) return ['echo', 'noop'];
  switch (act.act) {
    case 'check':
      return [INPUTCTL, 'check'];

    case 'click':
      return [INPUTCTL, 'click', Math.round(Number(act.x) || 0), Math.round(Number(act.y) || 0)];

    case 'type':
      return [INPUTCTL, 'type', String(act.text || '')];

    case 'key':
      return [INPUTCTL, 'key', String(act.keys || 'Enter')];

    case 'scroll':
      return [INPUTCTL, 'scroll', String(Number(act.ticks) || -3)];
    default:
      return ['echo', 'noop'];
  }
}

async function runTakeOver(req) {
  const goal = String(req.goal || '');
  const maxIter = Number(req.maxIterations || 30);
  const auto = req.autoApprove === true;
  if (!goal.trim()) return send('take:end', { ok: false, error: 'No goal.' });
  takeStop = false;
  if (takeAbort) { try { takeAbort.abort(); } catch {} }
  const ctrl = new AbortController();
  takeAbort = ctrl;
  send('take:event', { kind: 'start', text: `TAKE OVER — "${goal}"`, at: Date.now() });

  const tags = await ollamaTags();
  if (!tags.some((m) => m.toLowerCase().includes('llava') || m.toLowerCase().includes('moondream'))) {
    send('take:event', { kind: 'notice', text: `[warn] no vision model found (have: ${tags.join(', ') || 'none'}) — run: ollama pull llava` });
  }

  // Verify cursor control actually has permission up front.
  const tst = await injectInput({ act: 'check' });
  if (tst.out.includes('NOT_TRUSTED')) {
    send('take:event', { kind: 'notice', text: '[input] ⚠ not trusted — add this app to System Settings › Privacy & Security › Accessibility' });
  }

  // macOS permission checks are handled client-side; just loop.
  let context = 'No actions yet.';
  let failStreak = 0;
  let lastPos = null;
  let stuckClicks = 0;
  const repeatHint = () =>
    lastPos ? `you already clicked near (${lastPos.x}, ${lastPos.y}) and nothing changed` : '';
  for (let i = 0; i < maxIter; i++) {
    if (takeStop) return send('take:end', { stopped: true });
    if (ctrl.signal.aborted) return send('take:end', { stopped: true });
    let shot;
    try {
      shot = await captScreen();
      failStreak = 0;
    } catch (e) {
      send('take:event', { kind: 'notice', text: `[screenshot error] ${e.message}` });
      if (++failStreak >= 3) {
        return send('take:end', { ok: false, reason: `screen capture blocked — ${e.message}` });
      }
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    send('take:event', { kind: 'frame', b64: shot.b64, at: Date.now() });

    let act;
    try {
      act = await visionAction(shot.b64, goal, context, ctrl.signal, repeatHint());
      // If the vision reply wasn't valid JSON, give it exactly one retry.
      if (act && act.act === 'done' && /^unreadable vision reply/.test(String(act.why || ''))) {
        send('take:event', { kind: 'notice', text: '[vision] unreadable reply — retrying once' });
        act = await visionAction(shot.b64, goal, context, ctrl.signal, 'Return ONLY valid JSON, no prose.');
      }
    } catch (e) {
      if (/stopped/.test(String(e.message || ''))) return send('take:end', { stopped: true });
      send('take:event', { kind: 'notice', text: `[vision error] ${e.message}` });
      break;
    }
    // Map thumbnail pixels → real display points before showing or executing.
    const real = mapToScreen(act && act.act === 'click' ? { ...act } : act, shot);
    send('take:event', { kind: 'action', act: real, at: Date.now() });

    if (!act || act.act === 'done') {
      send('take:end', { ok: true, act: act || { act: 'done' }, iterations: i });
      return;
    }

    send('take:event', { kind: 'approve', act: real, auto, at: Date.now() });
    if (!auto) {
      const res = await waitForToolResult();
      if (takeStop) return send('take:end', { stopped: true });
      if (res.allow === false) { send('take:end', { ok: false, declined: true }); return; }
    }

    const r = await injectInput(real);
    let execTxt = `[${real.act}] (${r.ok ? 'ok' : 'fail'})`;
    if (!r.ok) execTxt += ` — ${r.out.replace(/\n/g, ' ').slice(0, 90)}`;
    context = `${context}\n${execTxt}`;
    send('take:event', { kind: 'notice', text: `[exec] ${execTxt}` });

    // Stuck guard: three consecutive clicks within ~12 px = give up cleanly.
    if (real.act === 'click') {
      const same =
        lastPos &&
        Math.abs(real.x - lastPos.x) <= 12 &&
        Math.abs(real.y - lastPos.y) <= 12;
      stuckClicks = same ? stuckClicks + 1 : 1;
      lastPos = { x: real.x, y: real.y };
      if (stuckClicks >= 3) {
        return send('take:end', { ok: false, reason: `stuck clicking at (${real.x}, ${real.y})` });
      }
    }

    await new Promise((res) => setTimeout(res, 900));
  }
  send('take:end', { ok: false, reason: 'iteration cap reached' });
}

function runTakeOverSafe(req) {
  runTakeOver(req || {}).catch((err) => {
    console.error('TAKE OVER crashed:', err);
    send('take:end', { ok: false, error: String(err.message || err) });
  });
}

ipcMain.on('take:start', (_e, req) => runTakeOverSafe(req));
ipcMain.on('take:stop', () => {
  takeStop = true;
  if (takeAbort) { try { takeAbort.abort(); } catch {} }
  if (pendingApprove) { pendingApprove.resolve({ allow: false }); pendingApprove = null; }
});