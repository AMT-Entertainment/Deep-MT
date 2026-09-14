/**
 * Extract paper-ready findings from the URANUS-VM experiment logs.
 * Reads the LATEST logs/run-*.jsonl, groups events per task, and reports
 * turn counts, tool-call counts, and outcomes per task.
 */
const fs = require('node:fs');
const path = require('node:path');

const LOGD = path.join(__dirname, 'logs');

function latestRun() {
  const files = fs
    .readdirSync(LOGD)
    .filter((f) => f.startsWith('run-') && f.endsWith('.jsonl'))
    .sort();
  if (!files.length) throw new Error('no run logs');
  return path.join(LOGD, files[files.length - 1]);
}

function main() {
  const file = latestRun();
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const tasks = {};
  let cur = null;
  let curStart = null;
  const order = [];
  for (const l of rows) {
    if (l.kind === 'task_start') {
      cur = { name: l.message, turns: 0, tools: 0, toolNames: [], modelTokens: 0, start: l.ts };
      curStart = l.ts;
      order.push(cur);
    } else if (cur) {
      if (l.kind === 'model_call') cur.turns++;
      if (l.kind === 'tool') {
        cur.tools++;
        cur.toolNames.push(l.name);
      }
    }
  }
  console.log(`Log: ${path.basename(file)}`);
  console.log('\nPer-task metrics (latest run):');
  console.log('  TASK | turns | tools | names');
  for (const t of order) {
    const names = (t.toolNames || []).join(', ');
    console.log(`  ${t.name} | ${t.turns} | ${t.tools} | ${names.slice(0, 80)}`);
  }
  const totalTools = order.reduce((a, t) => a + t.tools, 0);
  const totalTurns = order.reduce((a, t) => a + t.turns, 0);
  console.log(`\nTotals: turns=${totalTurns} tool-calls=${totalTools}`);
}

module.exports = { main };

if (require.main === module) {
  main();
}