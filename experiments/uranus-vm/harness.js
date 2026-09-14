/**
 * URANUS-VM experiment harness.
 * Drives llama3.1 (URANUS) against a real Alpine Linux VM.
 *
 * Tools exposed to the model:
 *   vm_exec  — run a shell command in the VM, returns stdout+stderr+exit code
 *   vm_read  — read a file
 *   vm_write — write a text file
 *   vm_check — list a directory (ls -la)
 *
 * Protocol is the same <tool:NAME>{"args"}</tool:NAME> marker pipeline used by
 * the DeepMT server. Every prompt, token, tool call and result is appended to
 * logs/run-<ts>.jsonl and logs/transcript-<ts>.md.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { extractToolCall } = require('/Users/macmini/Desktop/deep MT/server/tools/tools.js');

const VM_DIR = __dirname;
const HOST = '127.0.0.1';
const PORT = 2222;
const KEY = path.join(VM_DIR, 'vm', 'uranus_ssh');
const MODEL = 'llama3.1:latest';
const OLLAMA = 'http://127.0.0.1:11434/api/chat';

const LOG_DIR = path.join(VM_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL = path.join(LOG_DIR, `run-${ts}.jsonl`);
const MD = path.join(LOG_DIR, `transcript-${ts}.md`);

function log(kind, obj) {
  const line = { ts: new Date().toISOString(), kind, ...obj };
  fs.appendFileSync(JSONL, JSON.stringify(line) + '\n');
  console.log(`[${kind}]`, obj.message || obj.cmd || JSON.stringify(obj).slice(0, 120));
}

function md(text) {
  fs.appendFileSync(MD, text + '\n');
}

/* ---------------- SSH runner ---------------- */

/**
 * Visibly "types" a command into the guest console (the vmconsole window).
 * Each target command is appended to /tmp/uran-ai.log inside the VM, which
 * the live console window tails — so the AI's command shows up in the visible
 * VM window just before it actually runs over SSH. Purely cosmetic; never
 * blocks or fails the real exec.
 */
function announceToConsole(cmdText) {
  if (!cmdText) return;
  const safe = String(cmdText).replace(/\n/g, ' \\n ').replace(/'/g, "'\\''");
  spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=4',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-i', KEY,
    '-p', String(PORT),
    'root@' + HOST,
    `[ -w /tmp ] && printf '\\033[36m%s\\033[0m\\n' 'AI> ${safe}' >> /tmp/uran-ai.log || true`,
  ], { encoding: 'utf8', timeout: 5000 });
}

function sshExec(cmd, timeoutMs = 30000) {
  const r = spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-i', KEY,
    '-p', String(PORT),
    'root@' + HOST,
    cmd,
  ], { encoding: 'utf8', timeout: timeoutMs });
  return {
    exit: r.status == null ? -1 : r.status,
    out: String(r.stdout || '') + String(r.stderr || ''),
  };
}

const TOOLS = {
  vm_exec: {
    desc: 'Run a shell command in the VM. Args: {"cmd":"one shell command line"}',
    run: (args) => {
      const cmd = String(args.cmd || args.command || '').slice(0, 4000);
      if (!cmd || !cmd.trim()) return '[error] the vm_exec call had no "cmd" argument. Emit <tool:vm_exec>{"cmd":"<command>"}</tool:vm_exec> with the command in a single line.';
      announceToConsole(cmd);
      const r = sshExec(cmd);
      return `[exit ${r.exit}]\n${r.out.slice(0, 5000)}`;
    },
  },
  vm_read: {
    desc: 'Read a file. Args: {"path":"/root/x"}',
    run: (args) => {
      const p = String(args.path || args.file || '').slice(0, 2000);
      const r = sshExec(`cat -- '${p}' 2>&1`, 15000);
      return `[exit ${r.exit}]\n${r.out.slice(0, 6000)}`;
    },
  },
  vm_write: {
    desc: 'Write a text file (or append). Args: {"path":"/root/x","content":"...","append":true|false}',
    run: (args) => {
      const p = String(args.path || '').slice(0, 2000);
      const b64 = Buffer.from(String(args.content || ''), 'utf8').toString('base64');
      const op = args.append === true ? '>>' : '>';
      const r = sshExec(`mkdir -p "$(dirname -- '${p}')" && echo '${b64}' | base64 -d ${op} '${p}'`, 15000);
      return `[exit ${r.exit}]\n${r.out.slice(0, 1000)}`;
    },
  },
  vm_check: {
    desc: 'List a directory. Args: {"path":"/srv"}',
    run: (args) => {
      const p = String(args.path || '.').slice(0, 2000);
      const r = sshExec(`ls -la -- '${p}' 2>&1`, 15000);
      return `[exit ${r.exit}]\n${r.out.slice(0, 3000)}`;
    },
  },
};

function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, content: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` };
  try {
    return { ok: true, content: String(tool.run(args || {})), name, args };
  } catch (e) {
    return { ok: false, content: `tool "${name}" failed: ${e.message}`, name, args };
  }
}

/**
 * Parse a single <tool:NAME>{...}</tool:NAME> call, tolerating the JSON
 * slips llama emits: \$ escapes, single-quoted values, trailing ; etc.
 * Returns {name, args} or null.
 */
function parseToolCall(raw) {
  const m = /<(?:tool:)?([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)(?:<\/tool:[^>]*>|<\/[a-zA-Z_][a-zA-Z0-9_]*>|$)/.exec(raw);
  if (!m) return null;
  const name = m[1];
  if (!/^vm_(exec|read|write|check)$/.test(name)) return null;
  let body = m[2].trim();
  if (body.startsWith('{') || body.startsWith('[')) {
    // find balanced end
    const openCh = body[0];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, inStr = false, end = -1;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return { name, args: {} };
    body = body.slice(0, end);
    args = _parseJson(body);
    if (typeof args !== 'object' || args === null) args = {};
    return { name, args };
  }
  // Non-JSON arg forms llama actually emits:
  //   <tool:vm_check>("/root/x")</tool:vm_check>
  //   <tool:vm_exec>"echo hi"</tool:vm_exec>
  //   <tool:vm_read>/etc/hosts</tool:vm_read>
  let value = body.trim().replace(/^[(\[\{\s]+|[)\]\}\s;]+$/g, '');
  const q = /^(['"])(.*)\1$/s.exec(value);
  if (q) value = q[2];
  if (value === '' && /^[(\["']|$/.test(body.trim())) value = value || body.trim();
  const argKey = name === 'vm_read' || name === 'vm_check' ? 'path' : name === 'vm_write' ? 'content' : 'cmd';
  args = { [argKey]: value.trim().replace(/^(?:path|file|cmd|command)[: ]+/, '') };
  return { name, args };
}

/** JSON.parse with a tolerant cleanup pass. */
function _parseJson(body) {
  try {
    const args = JSON.parse(body);
    if (typeof args === 'object' && args !== null) return args;
  } catch { /* fall through */ }
  const cleaned = body
    .replace(/\\\$|\\"/g, (c) => c.slice(1))
    .replace(/\\(['"])/g, '$1');
  try {
    const args = JSON.parse(cleaned);
    if (typeof args === 'object' && args !== null) return args;
  } catch { /* fall through */ }
  // loose key:value fallback
  const args = {};
  for (const pair of body.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:)/)) {
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(pair);
    if (m) args[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return args;
}

/** Returns every <tool:...> call in order. */
function parseAllToolCalls(raw) {
  const calls = [];
  let rest = raw;
  while (rest) {
    const c = parseToolCall(rest);
    if (!c) break;
    calls.push(c);
    const idx = rest.indexOf('>');
    rest = rest.slice(idx + 1);
  }
  return calls;
}

/* ---------------- system prompt ---------------- */

function systemPrompt() {
  return [
    'You are URANUS, an autonomous AI system with root shell access to a small',
    'Alpine Linux virtual machine running on the host Mac. You are the ONLY',
    'operator; there is no human to ask. Work methodically: inspect, plan,',
    'execute, verify.',
    '',
    'Rules:',
    '- Use tools for every action: vm_exec (run shell), vm_read (read file),',
    '  vm_write (write file), vm_check (list dir).',
    '- When you need the machine to do something, emit ONLY the tool marker —',
    '  nothing else, no commentary, no "Output:", no anticipation:',
    '  <tool:vm_exec>{"cmd":"<one command line>"}</tool:vm_exec>',
    '- CRITICAL: NEVER write what the command will output. The result is',
    '  returned after the tool runs. Anything you write alongside a tool call',
    '  is NOT a real result.',
    '- Soberly wait for each result before continuing. Read it carefully and',
    '  base your next move on the REAL output, not on a guess.',
    '- Keep each command on one line; chain with && or ; . No tab characters.',
    '- Stop issuing tools only after you verified success; then give a short',
    '  summary quoting the ACTUAL numbers/files from the tool results.',
    '- Never guess or fabricate output: if a command errors, read the error',
    '  and adapt the next command.',
    '- Alpine has busybox tools: no GNU grep -P, use sed/awk; there is no',
    '  `timeout`; stray GNU flags error. The OS is Alpine; the VM root is tmpfs.',
  ].join('\n');
}

/* ---------------- model call (streaming) ---------------- */

async function streamChat(messages) {
  const res = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      options: { temperature: 0.6, num_predict: 2000 },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  while (true) {
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
        if (j.done) return content;
        if (j.message?.content) content += j.message.content;
      } catch { /* skip */ }
    }
  }
  return content;
}

/* ---------------- one task ---------------- */

async function solveTask(title, objective, extraSystem = '') {
  const messages = [
    { role: 'system', content: systemPrompt() + (extraSystem ? '\n\n' + extraSystem : '') },
    { role: 'user', content: `GOAL: ${objective}\n\nInside the VM, achieve the goal. When done, run a verification command and summarize with evidence.` },
  ];
  log('task_start', { message: title });
  md(`# Task: ${title}\n\n**Goal:** ${objective}\n\n`);
  let turns = 0;
  while (turns++ < 40) {
    log('model_call', { message: `turn ${turns}` });
    const content = await streamChat(messages);
    md(`--- turn ${turns} ---\n\n<model>\n${content.slice(0, 4000)}\n</model>\n`);
    const calls = parseAllToolCalls(content);
    let call = calls[0] || null;
    if (call) {
      // Store ONLY the text before the first marker. Everything the model
      // wrote after a marker (fake "Output:" blocks, extra markers) is
      // dropped so its confabulations never re-enter the context.
      const m1 = content.indexOf('<tool:');
      const m2 = content.indexOf('<vm_');
      let cut = -1;
      if (m1 === -1 && m2 !== -1) cut = m2;
      else if (m1 !== -1 && m2 === -1) cut = m1;
      else if (m1 !== -1 && m2 !== -1) cut = Math.min(m1, m2);
      const kept = cut === -1 ? content : content.slice(0, cut).trim();
      messages.push({ role: 'assistant', content: kept || '(tool call)' });
      const res = runTool(call.name, call.args);
      let feedback = toolFeedback(call, res);
      if (calls.length > 1) {
        feedback += `\n\nHARD RULE VIOLATION: your reply contained ${calls.length} tool markers. Only the FIRST was executed; the rest were ignored and everything you wrote after the marker was discarded. You must emit exactly ONE <tool:...> marker per reply, then wait for the result.`,
        md(`**WARNING:** reply contained ${calls.length} markers; only the first was run.\n`);
      }
      messages.push({ role: 'user', content: feedback });
      log('tool', { message: `${call.name}`, name: call.name, args: call.args, ok: res.ok, markers: calls.length });
      md(`\n**tool:** \`${call.name}\` ${JSON.stringify(call.args)}\n\n\`\`\`\n${res.content.slice(0, 3000)}\n\`\`\`\n`);
      continue;
    }
    messages.push({ role: 'assistant', content });
    log('task_end', { message: title + ' finished', turns });
    md(`\n## Result (turn ${turns})\n\n${content}\n`);
    return { turns, final: content };
  }
  return { turns, final: '(no tool breakthrough in 40 turns)' };
}

function toolFeedback(call, res) {
  return [
    `Tool <${call.name}> returned.`,
    res.ok ? 'It succeeded. Continue the task.' : 'It failed. Read the error and adapt.',
    '',
    res.content,
    '',
    res.ok !== true ? 'Try a different command or inspect with vm_check.' : null,
  ].filter(Boolean).join('\n');
}

module.exports = { solveTask, sshExec };