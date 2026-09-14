/**
 * DeepMT model registry.
 *
 *   MT 1.0 Lite    — fastest tier. Streamed from the remote Ollama host
 *                    (smollm2:1.7b). No daily limit.
 *   MT 1.0 Neptune — mid tier. Runs locally on the TurboFieldfare engine with
 *                    a reduced generation budget. 25 requests/day/user.
 *   MT 1.0 Jupiter — flagship tier. Runs locally on TurboFieldfare with the
 *                    full context and tool calling. 10 requests/day/user.
 *   MT 1.0 Uranus  — ultra tier. Runs on this Mac's own Ollama (llama3.1 8B):
 *                    dense and ~6× faster than Jupiter, with tool calling and
 *                    a higher daily budget to match. 20 requests/day/user.
 */

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://192.168.0.183:11434').replace(/\/+$/, '');
const LOCAL_OLLAMA_URL = (process.env.LOCAL_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_LITE_MODEL = process.env.OLLAMA_LITE_MODEL || 'alibayram/smollm3:latest';
const URANUS_OLLAMA_MODEL = process.env.URANUS_OLLAMA_MODEL || 'llama3.1:latest';
const TF_URL = (process.env.TURBOFIELDFARE_URL || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
const TF_MODEL = process.env.TURBOFIELDFARE_MODEL || 'gemma-4-26b-a4b-it';

const MODELS = {
  lite: {
    key: 'lite',
    id: 'MT 1.0 Lite',
    displayName: 'Lite',
    provider: 'ollama',
    ollamaModel: OLLAMA_LITE_MODEL,
    description: 'Fastest tier — SmolLM3 3B on the remote Ollama host. No daily limit.',
    rateLimit: Infinity,
    maxTokens: 1024,
    temperature: 0.6,
    tools: false,
  },
  neptune: {
    key: 'neptune',
    id: 'MT 1.0 Neptune',
    displayName: 'Neptune',
    provider: 'turbofieldfare',
    tfModel: TF_MODEL,
    description: 'Mid tier — local TurboFieldfare with a reduced generation budget. 25 requests/day.',
    rateLimit: 25,
    maxTokens: 1024,
    temperature: 0.5,
    thinking: false,
    tools: false,
  },
  jupiter: {
    key: 'jupiter',
    id: 'MT 1.0 Jupiter',
    displayName: 'Jupiter',
    provider: 'turbofieldfare',
    tfModel: TF_MODEL,
    description: 'Flagship tier — local TurboFieldfare with full context and tool calling. 10 requests/day.',
    rateLimit: 10,
    maxTokens: 2048,
    temperature: 0.4,
    thinking: false,
    tools: true,
  },
  uranus: {
    key: 'uranus',
    id: 'MT 1.0 Uranus',
    displayName: 'Uranus',
    provider: 'ollama-local',
    ollamaModel: URANUS_OLLAMA_MODEL,
    description: 'Ultra tier — llama3.1 8B on this Mac, ~6× faster than Jupiter with tool calling. 20 requests/day.',
    rateLimit: 20,
    maxTokens: 2048,
    temperature: 0.4,
    thinking: false,
    tools: true,
  },
};

function getModel(key) {
  return MODELS[String(key || '').toLowerCase()] || null;
}

function listModels() {
  return Object.values(MODELS).map((m) => ({
    key: m.key,
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    rateLimit: m.rateLimit,
    tools: m.tools,
    provider: m.provider,
  }));
}

module.exports = { MODELS, getModel, listModels, OLLAMA_URL, LOCAL_OLLAMA_URL, OLLAMA_LITE_MODEL, URANUS_OLLAMA_MODEL, TF_URL, TF_MODEL };
