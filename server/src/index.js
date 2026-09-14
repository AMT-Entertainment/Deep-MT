require('dotenv').config();
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { checkHealth, getHealth } = require('./engine');
const { listModels } = require('./models');
const { authRequired } = require('./auth');
const imagegen = require('./imagegen');
const { serveToolsOutputFile, userDir } = require('./files');
const { logEvent } = require('./events');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
// CORS + security headers (light, no overhead)
app.use(cors({ maxAge: 86400 }));
app.use((req, res, next) => {
  // Allow streaming to flush immediately — tell proxies not to buffer SSE
  if (req.path.startsWith('/api/chat/stream') || req.path.startsWith('/v1/chat') || req.path.startsWith('/api/demo')) {
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '100mb' }));

// Feed the terminal monitor: log every real API request (method, path, status,
// duration, caller). Noisy self-traffic is skipped so the monitor doesn't log
// its own presence every few seconds.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const p = req.path;
    if (
      req.method === 'OPTIONS' ||
      p.startsWith('/api/log') ||
      p.startsWith('/api/health') ||
      p.startsWith('/tools-output')
    ) {
      return;
    }
    logEvent('http', {
      message: `${req.method} ${p}`,
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      user: req.user?.email?.split('@')[0] || 'anon',
    });
  });
  next();
});

app.get('/api/health', async (_req, res) => {
  const img = await imagegen.checkHealth(true).catch(() => imagegen.getHealth());
  res.json({ status: 'ok', engines: getHealth(), imagegen: img, models: listModels() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/library', require('./routes/library'));
app.use('/api/tokens', require('./routes/tokens'));
app.use('/api/log', require('./routes/log'));
app.use('/api/archives', require('./routes/archives'));
app.use('/api/keys', require('./routes/apikeys'));
app.use('/api/demo', require('./routes/demo'));
app.use('/v1', require('./routes/openai'));

// Public shared archives — /u/<username>/shared/archives/<slug>. No auth:
// whoever has the link can view that one page. Must sit before the SPA
// catch-all so it isn't swallowed by index.html.
const { findPublicShare } = require('./shared');
app.get('/u/:username/shared/archives/:slug', (req, res) => {
  const share = findPublicShare(req.params.username, req.params.slug);
  if (!share) {
    return res
      .status(404)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Archive not found</title>' +
          '<body style="font-family:system-ui;padding:48px;text-align:center;color:#333">' +
          '<h1>404 · This archive doesn’t exist</h1>' +
          '<p>It may have been unshared, renamed, or the link is wrong.</p>' +
          '<p>Ask the person who sent you this link to re-share it.</p></body>',
      );
  }
  res.sendFile(require('node:path').join(userDir(share.userId), share.file), (err) => err && next(err));
});

// Per-account generated tool output (images / PDFs / documents) — mounted last
// so authenticated requests are resolved only against the owner's directory.
app.use('/tools-output', authRequired, serveToolsOutputFile);

// Production: serve the built client — aggressive cache for hashed assets, no-cache for html
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(
  express.static(clientDist, {
    maxAge: '1y',
    immutable: true,
    etag: true,
    lastModified: true,
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      } else if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff2?)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  // SPA fallback — never cached, always fresh
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(clientDist, 'index.html'), (err) => err && next());
});

app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  // Never let one bad request (or a stray rejected promise) take the server
  // down silently — log and keep serving.
  process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception:', err);
    process.exitCode = 1;
  });
  await checkHealth();
  logEvent('system', { message: 'DeepMT server started (port ' + PORT + ')', level: 'info' });
  const server = app.listen(PORT, () => {
    console.log(`DeepMT server listening on http://localhost:${PORT}`);
    console.log('Engines:', JSON.stringify(getHealth()));
    console.log('Models:', listModels().map((m) => `${m.id} (${m.provider})`).join(', '));
  });
  // Keep-alive tuning for live streaming: hold connections open, allow pipelining
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // SSE can be long-lived
  server.maxHeadersCount = 100;
}

main();
