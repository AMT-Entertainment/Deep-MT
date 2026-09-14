const D = window.deepmt;
const $ = (id) => document.getElementById(id);

/* ---------- the V: turns 90° and pauses while anything thinks ---------- */
const navLogo = document.querySelector('.nav__logo');
function setThinking(on) {
  navLogo?.classList.toggle('is-thinking', !!on);
}

/* ---------- statusbar (bottom footer) ---------- */
const statusLine = $('statusLine');
const statusMeta = $('statusMeta');
statusLine.textContent = ''; // drop the static "ready" placeholder text
const statusDot = Object.assign(document.createElement('span'), { className: 'statusbar__dot' });
statusLine.appendChild(statusDot);
const statusText = document.createElement('span');
statusLine.appendChild(statusText);
const fmtClock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function setStatus(text, { busy = false, off = false } = {}) {
  statusText.textContent = text || '';
  statusDot.classList.toggle('is-off', !!off);
  statusDot.classList[busy ? 'add' : 'remove']('is-busy');
  statusMeta.textContent = `UTC ${new Date().toISOString().slice(11, 19)} · ${fmtClock()}`;
}
setStatus('ready');

/* ---------- theme (mirrors the site) ---------- */
const root = document.documentElement;
const saved = localStorage.getItem('theme') || 'light';
root.setAttribute('data-theme', saved);
$('themeToggle').textContent = saved === 'dark' ? '☀' : '☾';
$('themeToggle').addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  $('themeToggle').textContent = next === 'dark' ? '☀' : '☾';
  localStorage.setItem('theme', next);
});

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('is-active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    $('tab-' + btn.dataset.tab).classList.add('is-active');
  });
});

/* ---------- engines ---------- */
let chatModel = null;
let visionModel = 'llava:latest';
let ollamaUp = false;
D.getEngines();
D.onEngines((p) => {
  chatModel = p.chat;
  visionModel = p.vision;
  ollamaUp = p.ollamaUp;
  $('visionModel').textContent = p.vision;
  $('oll-pill').textContent = p.ollamaUp
    ? `ollama ✓ ${p.tags.length} models · chat: ${p.chat}`
    : 'ollama · OFFLINE (start it)';
  setStatus(p.ollamaUp ? `ollama · ${p.tags.length} models · chat ${p.chat}` : 'ollama offline — start it', { off: !p.ollamaUp });
});
setInterval(() => D.getEngines(), 15000);

/* ---------- chat ---------- */
const chatScroll = $('chatScroll');
const history = [
  { role: 'system', content: 'You are URANUS, a fast, precise local assistant. Answer directly, with markdown.' },
];
let chatStreaming = false;
let streamEl = null;
let streamAcc = '';
function addMsg(role, text) {
  if (role === 'user' || role === 'ai') $('chatEmpty').style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatScroll.appendChild(div);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return div;
}
function updateComposer() {
  const btn = $('chatSend');
  btn.textContent = chatStreaming ? '■' : '→';
  btn.title = chatStreaming ? 'Stop generating' : 'Send';
  btn.disabled = false;
}
// Registered once — later sends only replace the active stream element.
D.onChatDelta(({ delta }) => {
  if (!streamEl) return;
  streamAcc += delta;
  streamEl.textContent = streamAcc + '▍';
  chatScroll.scrollTop = chatScroll.scrollHeight;
});
D.onChatEnd(({ ok, error, stopped }) => {
  if (!streamEl) return;
  streamEl.textContent = stopped ? '⚠ stopped' : ok ? streamAcc : '⚠ ' + (error || 'stopped');
  chatStreaming = false;
  if (ok) history.push({ role: 'assistant', content: streamAcc });
  streamEl = null;
  streamAcc = '';
  updateComposer();
  setThinking(chatStreaming || mtBusy || takeBusy);
  setStatus(stopped ? 'chat stopped' : ok ? 'reply done' : 'chat failed', { busy: mtBusy || takeBusy });
});
function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text || chatStreaming) return;
  if (!ollamaUp) {
    addMsg('ai', '⚠ Ollama is offline — start it (ollama serve) and try again.');
    return;
  }
  $('chatInput').value = '';
  history.push({ role: 'user', content: text });
  addMsg('user', text);
  streamAcc = '';
  streamEl = addMsg('ai', '');
  chatStreaming = true;
  updateComposer();
  setThinking(true);
  setStatus('streaming from ' + (chatModel || 'ollama'), { busy: true });
  D.chatSend(history.slice(-20), chatModel || 'llama3.1:latest');
}
function stopChat() {
  if (!chatStreaming) return;
  D.chatStop();
}
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chatStreaming) stopChat(); else sendChat();
});
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (chatStreaming) stopChat(); else sendChat();
  }
});
$('chatSend').addEventListener('click', (e) => {
  e.preventDefault();
  if (chatStreaming) stopChat(); else sendChat();
});

/* ---------- [MT] host agent ---------- */
const mtLog = $('mtLog');
const mtApproval = $('mtApproval');
let mtBusy = false;
let mtPending = null;

function mtLine(kind, text) {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = text;
  mtLog.appendChild(div);
  mtLog.scrollTop = mtLog.scrollHeight;
}
function fmtArgs(a) {
  try { return JSON.stringify(a); } catch { return String(a); }
}

D.onMtAllStart(() => { mtLog.innerHTML = ''; });
D.onMtEvent((e) => {
  switch (e.kind) {
    case 'start': mtLine('t', e.text); break;
    case 'assistant': {
      const div = mtLog.lastElementChild;
      if (div && div.classList.contains('u')) {
        div.textContent += e.delta;
      } else {
        mtLine('u', e.delta);
      }
      mtLog.scrollTop = mtLog.scrollHeight;
      break;
    }
    case 'tool': mtLine('t', `▶ ${e.name} ${fmtArgs(e.args)}`); break;
    case 'result': mtLine('m', e.text.slice(0, 400) + (e.text.length > 400 ? ' …' : '')); break;
    case 'approve': {
      mtPending = e;
      if (e.auto) { mtLine('m', '[auto-approve]'); D.mtApprove(true); }
      else {
        mtApproval.hidden = false;
        $('mtApprovalTx').textContent = `URANUS wants to run: ${e.name} ${fmtArgs(e.args)}`;
      }
      break;
    }
    case 'blocked': mtLine('e', '[blocked] destructive command refused'); break;
    case 'final': mtLine('t', e.delta || ''); break;
  }
});
D.onMtEnd((r) => {
  mtBusy = false;
  mtApproval.hidden = true;
  if (r.stopped) mtLine('e', '— stopped by user —');
  else if (!r.ok) mtLine('e', 'error: ' + (r.error || '?'));
  else mtLine('t', `— [MT] done in ${r.turns} turns —`);
  setThinking(chatStreaming || mtBusy || takeBusy);
  if (!r.stopped && !r.ok) setStatus('[MT] failed: ' + (r.error || '?'), { off: true });
});
$('mtStart').addEventListener('click', () => {
  const goal = $('mtGoal').value.trim();
  if (!goal || mtBusy) return;
  mtBusy = true;
  mtLog.innerHTML = '';
  setThinking(true);
  setStatus('[MT] running "' + goal.slice(0, 40) + '"', { busy: true });
  D.mtGoal({ goal, model: chatModel, autoApprove: $('mtAuto').checked });
});
$('mtStop').addEventListener('click', () => D.mtStop());
$('mtYes').addEventListener('click', () => { mtApproval.hidden = true; D.mtApprove(true); });
$('mtNo').addEventListener('click', () => { mtApproval.hidden = true; D.mtApprove(false); });

/* ---------- TAKE OVER ---------- */
const takeLog = $('takeLog');
const takeApproval = $('takeApproval');
let takeBusy = false;
let takePending = null;
let currentFrameB64 = null;

function takeLine(kind, text) {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = text;
  takeLog.appendChild(div);
  takeLog.scrollTop = takeLog.scrollHeight;
}
D.onTakeEvent((e) => {
  switch (e.kind) {
    case 'start': takeLog.innerHTML = ''; takeLine('t', e.text); break;
    case 'frame':
      currentFrameB64 = e.b64;
      $('takeFrame').src = 'data:image/png;base64,' + e.b64;
      break;
    case 'action': takeLine('t', `→ ${e.act.act} ${fmtArgs(e.act).slice(0, 160)}`); break;
    case 'approve': {
      takePending = e;
      if (e.auto) { takeLine('m', '[auto-approve]'); D.takeApprove(true); }
      else {
        takeApproval.hidden = false;
        $('takeApprovalTx').textContent = `Execute: ${fmtArgs(e.act).slice(0, 200)}`;
      }
      break;
    }
    case 'notice': takeLine('m', e.text); break;
  }
});
D.onTakeEnd((r) => {
  takeBusy = false;
  takeApproval.hidden = true;
  takeLine('t', r.stopped ? '— stopped by user —' : r.ok ? `— done: ${r.act ? r.act.why : ''} —` : '— ended: ' + (r.reason || r.error || '?'));
  setThinking(chatStreaming || mtBusy || takeBusy);
  setStatus(r.stopped ? 'TAKE OVER stopped' : r.ok ? 'TAKE OVER done' : 'TAKE OVER: ' + (r.reason || r.error || '?'), { busy: mtBusy || chatStreaming });
});
$('takeStart').addEventListener('click', () => {
  const goal = $('takeGoal').value.trim();
  if (!goal || takeBusy) return;
  takeBusy = true;
  takeLog.innerHTML = '';
  setThinking(true);
  setStatus('TAKE OVER "' + goal.slice(0, 40) + '"', { busy: true });
  D.takeStart({ goal, autoApprove: $('takeAuto').checked, maxIterations: 30 });
});
$('takeStop').addEventListener('click', () => D.takeStop());
$('takeYes').addEventListener('click', () => { takeApproval.hidden = true; D.takeApprove(true); });
$('takeNo').addEventListener('click', () => { takeApproval.hidden = true; D.takeApprove(false); });

/* global stop */
$('globalStop').addEventListener('click', () => { D.chatStop(); D.mtStop(); D.takeStop(); setThinking(false); });
