/**
 * DeepMT library API — the user's own generated media (gallery) and
 * client-side image variations.
 *
 *   GET  /api/library            -> { images: [...], files: [...] } (own only)
 *   POST /api/library/variation  -> { url } new img2img variation of an image
 */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { authRequired } = require('../auth');
const { userDir, listUserImages, registerImage, sanitizeUserId } = require('../files');
const imagegen = require('../imagegen');

const router = express.Router();
router.use(authRequired);

/** Media kinds that can be thumbnailed inline in the gallery. */
const THUMB_KINDS = new Set(['image', 'chart', 'qr', 'diagram']);

router.get('/', (req, res) => {
  const uid = req.user.id;
  const dir = userDir(uid);
  const images = listUserImages(uid, 120).map((img) => ({
    ...img,
    isImage: THUMB_KINDS.has(img.kind),
  }));

  // Other files in the user's folder that were never registered as images
  // (PDFs, markdown, text, sites…).
  const registered = new Set(images.map((i) => i.file));
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (registered.has(entry)) continue;
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        file: entry,
        url: `/tools-output/${sanitizeUserId(uid)}/${entry}`,
        size: stat.size,
        prompt: '',
        seed: null,
        kind: path.extname(entry).slice(1).toLowerCase() || 'file',
        isImage: /\.(png|jpe?g|gif|webp|svg)$/i.test(entry),
        created_at: stat.mtime.toISOString(),
      });
    }
  } catch {
    /* folder read failure — return what we have */
  }

  const isCurrent = (img) => {
    try {
      return fs.existsSync(path.join(dir, img.file));
    } catch {
      return false;
    }
  };
  res.json({
    images: images.filter(isCurrent),
    files: files.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  });
});

/**
 * Creates a variation of one of the user's own images via img2img: same
 * prompt as the original, fresh seed, gentle strength. The result is saved as
 * a new file in the user's folder. Cross-user sources are rejected.
 */
router.post('/variation', async (req, res) => {
  const uid = req.user.id;
  const source = String((req.body && req.body.url) || (req.body && req.body.source) || '');
  const strength = Number((req.body && req.body.strength) || 0.5);
  if (!source) return res.status(400).json({ error: 'A source image URL is required' });

  const fileName = path.basename(String(source).split('?')[0]);
  if (!fileName || !/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.length > 120) {
    return res.status(400).json({ error: 'Invalid source image' });
  }
  const dir = userDir(uid);
  if (!fs.existsSync(path.join(dir, fileName))) {
    return res.status(404).json({ error: 'Source image not found (must be one of your own images)' });
  }

  // Prefer the original prompt (variation = same idea, new seed); the model
  // stays in the user's lane at low strength so the image keeps its identity.
  let prompt;
  try {
    const row = db
      .prepare('SELECT prompt FROM images WHERE user_id = ? AND file = ? ORDER BY rowid DESC LIMIT 1')
      .get(uid, fileName);
    prompt = (row && row.prompt) || 'A refined variation of this image, same subject and composition';
  } catch (err) {
    return res.status(500).json({ error: 'Variation lookup failed: ' + err.message });
  }

  try {
    const out = await imagegen.editImage(uid, prompt, fileName, 512, Math.min(0.7, Math.max(0.3, strength)));
    res.json({ url: out.url, file: out.file, seed: out.seed, editedFrom: fileName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
