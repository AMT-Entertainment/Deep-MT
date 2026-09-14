const express = require('express');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { authRequired } = require('../auth');
const { logEvent, recentEvents, onEvent } = require('../events');

const router = express.Router();
router.use(authRequired);

/** GET /api/log/events — snapshot of recent console events (newest last). */
router.get('/events', (_req, res) => {
  res.json({ events: recentEvents() });
});

/**
 * GET /api/log/stream — SSE feed of live console events.
 *   event: history -> { events: [...] }  (buffered snapshot first)
 *   event: event   -> { event: {...} }
 * Kept alive with `: ping` comments every 15 s; EventSource auto-reconnects.
 */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`retry: 3000\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify({ events: recentEvents() })}\n\n`);

  const unsubscribe = onEvent((event) => {
    res.write(`event: event\ndata: ${JSON.stringify({ event })}\n\n`);
  });
  const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
  ping.unref?.();

  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

/**
 * POST /api/log/open — spawn the native monitoring terminal on this Mac
 * (macOS only; opens Terminal.app and starts the console app).
 */
router.post('/open', (_req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(400).json({ error: 'Native console is only available on this machine via Terminal.app.' });
  }
  const launcher = path.resolve(__dirname, '..', 'open-console.js');
  execFile(process.execPath, [launcher], { timeout: 15_000 }, (err, _out, stderr) => {
    if (err) {
      logEvent('system', { }, `Could not open monitoring terminal: ${(stderr || err.message).trim()}`);
      return res.status(500).json({ error: 'Could not open the monitoring terminal.' });
    }
    logEvent('chat', { }, 'Monitoring terminal opened');
    res.json({ ok: true });
  });
});

module.exports = router;