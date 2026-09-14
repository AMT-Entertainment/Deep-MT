/**
 * DeepMT vision — image understanding via the local Ollama instance.
 *
 * Images uploaded by a user are described with a multimodal model (llava by
 * default, configurable with VISION_MODEL) so the chat engine "sees" them even
 * though the text models are text-only. The description is injected into the
 * user turn before it reaches the engine.
 */
const fs = require('node:fs');
const path = require('node:path');
const { userDir } = require('./files');

// Vision prefers the local Ollama instance (VISION_URL) — the chat engines
// may run on a remote host, but images are described on this machine.
const OLLAMA_URL = (process.env.VISION_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const MODEL = process.env.VISION_MODEL || 'llava';
const TIMEOUT = Number(process.env.VISION_TIMEOUT || 60_000);

let availability = null; // true | false | 'checking'
let lastCheck = 0;
const CHECK_CACHE_MS = 60_000;

async function isModelAvailable(force = false) {
  const now = Date.now();
  if (!force && availability !== null && now - lastCheck < CHECK_CACHE_MS) {
    return availability;
  }
  availability = 'checking';
  lastCheck = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('offline');
    const { models = [] } = await res.json();
    availability = models.some((m) => m.name === MODEL || m.name.startsWith(MODEL + ':'));
  } catch {
    clearTimeout(timer);
    availability = false;
  }
  return availability;
}

/** Reads an image file owned by the user and describes it in one sentence. */
async function describeImage(userId, fileName, extraPrompt = '') {
  const dir = userDir(userId);
  const safe = path.basename(String(fileName || '').split('?')[0]);
  const full = path.join(dir, safe);
  if (!full.startsWith(dir + path.sep)) throw new Error('Invalid image path');
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    throw new Error('Image file not found');
  }

  if (!(await isModelAvailable())) {
    const list = await isModelAvailable(true);
    if (!list) {
      throw new Error(
        `Vision model "${MODEL}" is not installed on Ollama. Run: ollama pull ${MODEL}`,
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content:
              'Describe this image concisely in 2-3 sentences: what is visible, the subject, the setting and any notable details or text. ' +
              extraPrompt,
            images: [buf.toString('base64')],
          },
        ],
        stream: false,
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama vision responded ${res.status}`);
    const body = await res.json();
    return String(body.message?.content || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Vision timed out after ${TIMEOUT / 1000}s`);
    throw new Error(`Vision failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { describeImage, isModelAvailable };
