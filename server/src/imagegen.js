/**
 * DeepMT image generation gateway — Stable Diffusion (sd-turbo) running in the
 * Python service at server/imagegen (loopback only, 512x512 PNGs).
 *
 *   GET  /health    -> { ok, loaded }
 *   POST /generate  -> {prompt, seed?} => PNG bytes
 *
 * The Node server never runs the model itself; it proxies prompts and saves
 * the PNGs into tools-output/ so they are served at /tools-output/<file>.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { userDir, registerImage } = require('./files');

const IMG_URL = (process.env.IMGGEN_URL || 'http://127.0.0.1:7861').replace(/\/+$/, '');

const HEALTH_CACHE_MS = 15_000;
let health = { imagegen: 'checking', loaded: false };
let lastHealthCheck = 0;

/** Re-probes the imagegen service, cached for HEALTH_CACHE_MS unless forced. */
async function checkHealth(force = false) {
  const now = Date.now();
  if (!force && now - lastHealthCheck < HEALTH_CACHE_MS) return { ...health };
  lastHealthCheck = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${IMG_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      setHealth({ imagegen: 'online', loaded: !!body.loaded }, body);
    } else {
      setHealth({ imagegen: 'offline', loaded: false });
    }
  } catch {
    clearTimeout(timer);
    setHealth({ imagegen: 'offline', loaded: false });
  }
  return { ...health };
}

/** Emits a console event whenever the image engine's state flips. */
function setHealth(next, extra = {}) {
  const prev = health.imagegen;
  health = next;
  if (prev !== next.imagegen) {
    require('./events').logEvent('engines', {
      engine: 'imagegen',
      online: next.imagegen === 'online',
      level: next.imagegen === 'online' ? 'info' : 'error',
      message: `imagegen ${next.imagegen === 'online' ? 'connected' : 'disconnected'}`,
      ...extra,
    });
  }
}

function isOnline() {
  return health.imagegen === 'online';
}

/** Reads width/height from a PNG buffer (header: bytes 16..23). */
function pngDims(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  try {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function savePng(userId, bytes, prefix, size) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
  const dims = pngDims(bytes);
  const tag = dims ? `${dims.width}x${dims.height}` : `${size || 512}px`;
  const name = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}-${tag}.png`;
  const dir = userDir(userId);
  fs.writeFileSync(path.join(dir, name), bytes);
  return {
    file: name,
    url: `/tools-output/${path.basename(dir)}/${name}`,
    size: dims && dims.width === dims.height ? dims.width : (size || 512),
    width: dims ? dims.width : null,
    height: dims ? dims.height : null,
  };
}

/**
 * Generates a 512x512 or 1024x1024 PNG via the sd-turbo service, saved into
 * the owner's private directory and recorded in the images table.
 * Returns { url, file, prompt, seed, size }. Throws when the service is down.
 */
async function generateImage(prompt, seed, userId, size = 512) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('A prompt string is required');
  }
  const px = size === 1024 ? 1024 : 512;
  await checkHealth();
  if (!isOnline()) throw new Error('The image engine is offline (imagegen service not running).');

  const s = seed == null ? Math.floor(Math.random() * 2 ** 31) : Number(seed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let res;
  try {
    res = await fetch(`${IMG_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.slice(0, 1000), seed: s, size: px }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Image engine unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Image engine failed (${res.status}): ${body.error || 'unknown error'}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const saved = savePng(userId, buf, 'img', px);
  registerImage(userId, saved.file, prompt.trim(), s, 'image');
  return { ...saved, prompt: prompt.trim(), seed: s };
}

/**
 * Edits one of the user's own images via img2img (sd-turbo). The source is a
 * /tools-output URL or file name owned by this user; anything else is rejected.
 * Returns { url, file, prompt, seed, size, editedFrom }.
 */
async function editImage(userId, prompt, source, size = 512, strength = 0.45) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('An edit instruction is required');
  }
  if (!userId) throw new Error('User required for image editing');

  const { userDir } = require('./files');
  const dir = userDir(userId);
  const fileName = path.basename(String(source || '').split('?')[0]);
  if (!fileName || !/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.length > 120) {
    throw new Error('Invalid source image');
  }
  const full = path.join(dir, fileName);
  if (!full.startsWith(dir + path.sep)) throw new Error('Invalid source image');
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    throw new Error('Source image not found (it must be one of your own images)');
  }

  const px = size === 1024 ? 1024 : 512;
  await checkHealth();
  if (!isOnline()) throw new Error('The image engine is offline (imagegen service not running).');

  const s = Math.floor(Math.random() * 2 ** 31);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let res;
  try {
    res = await fetch(`${IMG_URL}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt.slice(0, 1000),
        image: buf.toString('base64'),
        seed: s,
        size: px,
        strength,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Image engine unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Image engine failed (${res.status}): ${body.error || 'unknown error'}`);
  }
  const outBuf = Buffer.from(await res.arrayBuffer());
  const saved = savePng(userId, outBuf, 'edit', px);
  registerImage(userId, saved.file, prompt.trim(), s, 'image');
  return {
    ...saved,
    prompt: prompt.trim(),
    seed: s,
    editedFrom: fileName,
  };
}

/** One user's own generated images, newest first (from the images table). */
function listImages(userId, limit = 60) {
  const { listUserImages } = require('./files');
  return listUserImages(userId, limit);
}

function getHealth() {
  return { ...health, url: IMG_URL };
}

module.exports = { generateImage, editImage, listImages, checkHealth, isOnline, getHealth };
