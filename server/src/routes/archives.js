/**
 * Archives API — list the user's generated HTML archives and manage public
 * shares (custom slugs under /u/<username>/shared/archives/<slug>).
 */
const express = require('express');
const fs = require('node:fs');
const { authRequired } = require('../auth');
const { userDir } = require('../files');
const { sanitizeUserId } = require('../files');
const { share, unshareArchive, sharedByUser } = require('../shared');

const router = express.Router();
router.use(authRequired);

/** Lists the Windows-readable .html archives in the user's folder, newest first,
 * plus any public shares. */
router.get('/', (req, res) => {
  const dir = userDir(req.user.id);
  const uid = sanitizeUserId(req.user.id);
  const sites = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.html$/i.test(name)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(require('node:path').join(dir, name)).mtimeMs; } catch { /* skip */ }
      sites.push({ file: name, url: `/tools-output/${uid}/${name}`, mtime });
    }
  } catch { /* dir missing */ }
  sites.sort((a, b) => b.mtime - a.mtime);
  const shared = sharedByUser(req.user.id);
  const sharedByFile = {};
  for (const s of shared) sharedByFile[s.file] = s;
  res.json({ sites: sites.map((s) => ({ ...s, shared: sharedByFile[s.file] || null })), shared });
});

/** POST /api/archives/share  { file, slug? } — publish an archive. */
router.post('/share', (req, res) => {
  const { file, slug } = req.body || {};
  try {
    const row = share(req.user, file, slug);
    res.json({ shared: row });
  } catch (err) {
    if (err.code === 'no_file') return res.status(404).json({ error: err.message });
    if (err.code === 'slug_taken') return res.status(409).json({ error: err.message });
    return res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/archives/share/:slug — unshare a page the user owns. */
router.delete('/share/:slug', (req, res) => {
  if (unshareArchive(req.user.id, req.params.slug)) return res.json({ ok: true });
  res.status(404).json({ error: 'No share with that link name' });
});

module.exports = router;