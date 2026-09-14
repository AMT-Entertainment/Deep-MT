#!/usr/bin/env node
/**
 * Launch the DeepMT system console in a native macOS Terminal window.
 * Works only on macOS (Terminal.app) — prints an error elsewhere.
 */
const { execFile } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.error('The native console only opens on macOS (Terminal.app).\nRun it manually here instead:  node src/console.js');
  process.exit(1);
}

const dir = path.resolve(__dirname, '..');
const command = `cd "${dir}" && node src/console.js`;
const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`;

execFile('osascript', ['-e', script], { timeout: 15000 }, (err) => {
  if (err) {
    console.error('Failed to open Terminal:', err.message);
    process.exit(1);
  }
  console.log(`Opened DeepMT console in Terminal (${dir}).`);
});