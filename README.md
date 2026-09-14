# DeepMT — Full Stack System

DeepMT is a self-hosted AI workspace with **four model tiers**, a minimal
brand-driven UI (Playfair Display + Inter, #88B0A8 teal on #F1F4E0 cream), and
a public homepage in **English, German and Polish**.

Built from the two design documents in this folder:
`DeepMT_System_Architecture.pdf` and `DeepMT_UI_Design_System.pdf`.

```
├── server/               Node.js + Express API (JWT auth, SQLite, SSE streaming)
│   ├── src/models.js     model registry & tier configuration
│   ├── src/usage.js      per-user daily rate limiting
│   └── tools/            Jupiter tool implementations + protocol docs
├── client/               React + Vite frontend (homepage, auth modal, chat)
├── ecosystem.config.js   PM2 process management for the Mac Mini
└── README.md
```

## Model tiers

| Tier            | Engine                     | Where it runs        | Daily limit per user | Tools |
| --------------- | -------------------------- | -------------------- | -------------------- | ----- |
| **MT 1.0 Lite** | SmolLM3 3B (Q4_K_M) via Ollama | LAN host `192.168.0.183` | unlimited | — |
| **MT 1.0 Neptune** | Gemma 4 26B-A4B (TF, reduced budget) | this Mac Mini | 25            | —     |
| **MT 1.0 Jupiter** | Gemma 4 26B-A4B (TF, full budget) | this Mac Mini | 10            | web_search, run_code, get_time |
| **MT 1.0 Uranus** | llama3.1 8B via local Ollama | this Mac Mini (`127.0.0.1:11434`) | 20 | web_search, run_code, get_time |

In the chat interface the tiers are shown as **Lite**, **Neptune**, **Jupiter**
and **Uranus** (the "1.0" is dropped in the UI). The server auto-detects which
engines are online and marks the others as unavailable in the model picker.

## Quick start

```bash
# 1. Backend
cd server
npm install
cp .env.example .env      # set a strong JWT_SECRET!
npm start                 # http://localhost:3000

# 2. Frontend (dev mode with hot reload)
cd ../client
npm install
npm run dev               # http://localhost:5173  (proxies /api to :3000)

# 3. Production build (served by the backend at :3000)
npm run build
```

Lite works immediately over the LAN Ollama host. Neptune and Jupiter need the
TurboFieldfare engine running on this machine (see below).

## The engines

### Lite — Ollama (LAN)

The server talks to `http://192.168.0.183:11434` and uses `alibayram/smollm3:latest`
(change both in `server/.env`). SmolLM3 is a 3B dual-mode reasoner; the server
strips its `<think>` blocks so only the final answer streams. Responses are
streamed from the remote host; the model itself never runs on the Mac Mini.

### Uranus — Ollama (this Mac)

Uranus runs `llama3.1:latest` on the Ollama listening at
`127.0.0.1:11434`. Because it is dense rather than MoE, a real 8B quadratic
reads much faster than the 26B gemma tile: it is roughly **6× faster than
Jupiter** while keeping tool calling. Override with `LOCAL_OLLAMA_URL` /
`URANUS_OLLAMA_MODEL` in `server/.env`.

### Neptune & Jupiter — TurboFieldfare (local)

TurboFieldfare streams Gemma 4 26B-A4B on Apple Silicon (~2 GB RAM footprint).
Built and installed in `~/turbo-fieldfare`:

```bash
cd ~/turbo-fieldfare
swift build -c release --product TurboFieldfareServer --product TurboFieldfareRepack
# first run installs the ~14.3 GB model (streamed from Hugging Face):
.build/release/TurboFieldfareRepack --output scratch/gemma4.gturbo --overwrite
# resume an interrupted download:
.build/release/TurboFieldfareRepack --output scratch/gemma4.gturbo --overwrite --resume

.build/release/TurboFieldfareServer --model scratch/gemma4.gturbo --port 8080
# wait for: TurboFieldfareServer ready
```

The DeepMT server probes `http://127.0.0.1:8080/health` at startup. Neptune
uses a reduced generation budget (1K max tokens); Jupiter uses the full budget
(4K) plus tool calling. Restart the DeepMT server after starting the engine so
the tiers unlock.

## Tool calling (Jupiter & Uranus)

Tools are implemented in `server/tools/` (`tools.js` + `README.md`), and the
system prompt tells the model how to call them by emitting:

```
<tool:web_search>{"query":"mac mini m5 benchmarks"}</tool:web_search>
```

| Tool         | What it does                                                        |
| ------------ | ------------------------------------------------------------------- |
| `web_search` | DuckDuckGo search; returns up to 5 titled results.                  |
| `fetch_url`  | Fetch a public page and return its readable text (http/https only, 8 KB cap). |
| `make_image` | **Real 512×512 Stable Diffusion (sd-turbo)** image via `server/imagegen`; instant SVG fallback when the engine is offline. |
| `make_chart` | Bar / line / pie chart rendered as SVG from numeric data.           |
| `make_pdf`   | Direct PDF creation: `{"text": "...", "filename": "..."}` → download URL. |
| `make_file`  | Save md/txt/csv file to `/tools-output/`.                           |
| `get_weather`| Current weather for a city (Open-Meteo, no key).                    |
| `get_news`   | Recent headlines from Google News RSS (optional topic query).       |
| `get_wikipedia` | Concise article summary from Wikipedia.                          |
| `run_code`   | Sandboxed JS (no network/fs). Helpers: `makePdf(text, name)` → PDF in `server/tools-output/` served at `/tools-output/<file>`, and `result(value)`. |
| `calculate`  | Safe arithmetic evaluation in a VM (only `Math` exposed).          |
| `get_time`   | Current server date/time.                                           |
| `get_system_info` | Server host/platform/CPU/uptime/engine status.                  |

Generated PDFs land in `server/tools-output/` (as do generated images, SVGs
and charts). Assistant answers are rendered as Markdown in the chat UI (bold,
lists, code blocks, tables, links). Generated images appear **inline** in the
chat and are downloadable.

## Image generation (512×512)

A separate Python service (`server/imagegen/`, Flask + PyTorch MPS) runs
**Stable Diffusion sd-turbo** and renders **512×512 PNGs** in a few seconds:

```bash
cd server/imagegen
./imagegen.sh          # installs venv + torch on first run, then serves 127.0.0.1:7861
./imagegen.sh stop     # stop it
```

The DeepMT server proxies it through two authenticated endpoints:

| Method | Path                   | Description                                   |
| ------ | ---------------------- | --------------------------------------------- |
| POST   | /api/images/generate   | `{ prompt, seed? }` → `{ url, seed, width, height }` |
| GET    | /api/images            | Recently generated images, newest first       |

In the chat UI the 🎨 **Image** button opens a direct generator (prompt field,
preview, download + open buttons, and a grid of recent images). Jupiter's
`make_image` tool calls the same engine — the PNG appears inline in the reply
and in the image history. `/tools-output/<file>.png` serves the files
(square 512×512). `server/imagegen` is registered as the `deepmt-imagegen`
PM2 app.

## Rate limits

Enforced per user, per model, per calendar day (stored in SQLite,
`usage_daily` table): **Jupiter 10**, **Uranus 20**, **Neptune 25**, **Lite
unlimited**. Exceeding a limit returns `429` with a friendly message; the model
picker shows live `used/today` counters and locks exhausted tiers. API requests
made through `/v1` count against the same per-day budgets of the key's owner.

## API surface

| Method | Path                    | Description                              |
| ------ | ----------------------- | ---------------------------------------- |
| POST   | /api/auth/register      | Register (bcrypt-hashed password)        |
| POST   | /api/auth/login         | Login → JWT                              |
| GET    | /api/auth/me            | Current user                             |
| GET    | /api/sessions           | List conversations                       |
| POST   | /api/sessions           | Create conversation                      |
| PATCH  | /api/sessions/:id       | Rename conversation                      |
| DELETE | /api/sessions/:id       | Delete conversation + messages           |
| GET    | /api/sessions/:id/messages | Message history                       |
| GET    | /api/chat/models        | Model tiers, online status, today's usage |
| POST   | /api/chat/stream        | SSE stream — `thinking` → `tool`? → `token`* → `done` |
| POST   | /api/images/generate    | Generate a 512×512 image → `{ url, seed }` |
| GET    | /api/images             | Recently generated images |
| GET    | /api/keys               | List your API keys (no secrets) |
| POST   | /api/keys               | Create an API key → plaintext returned **once** |
| DELETE | /api/keys/:id           | Revoke an API key |
| GET    | /v1/models              | OpenAI-compatible model list (API key) |
| POST   | /v1/chat/completions    | OpenAI-compatible chat (API key, stream or JSON) |

`/api/chat/stream` takes `{ session_id, content, model }` where `model` is
`lite`, `neptune`, `jupiter` or `uranus`. SSE events: `thinking`, `tool`,
`token`, `done`, `error`. All endpoints except auth require
`Authorization: Bearer <JWT>`.

## OpenAI-compatible API (`/v1`)

Generate an API key in the web UI (**API** button in the top bar), then use it
from any OpenAI SDK or script — the full tool pipeline runs server-side and
requests count against the key owner's daily model limits.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-deepmt-…" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "uranus",
    "messages": [{"role": "user", "content": "What time is it?"}],
    "stream": true
  }'
```

- `model` accepts a tier key (`uranus`, `jupiter`, …) or a display name
  (`"MT 1.0 Uranus"`); omitted → `uranus`.
- `messages` follows the OpenAI schema; `content` may be a string or an array
  of `{ type: 'text', text }` parts.
- `temperature` / `max_tokens` override the tier defaults.
- `stream: true` returns OpenAI-style SSE chunks ending with `data: [DONE]`;
  otherwise a complete `chat.completion` JSON body with `usage` is returned.
- Keys are stored only as salted SHA-256 hashes; the plaintext is shown once at
  creation and can be revoked from the same panel at any time.

## Data model (SQLite)

- `users` — id, email, password_hash, created_at, active_status
- `sessions` — id, user_id, title (auto-generated from the first prompt), created_at
- `messages` — id, session_id, role (user/ai), content, created_at
- `usage_daily` — user_id, model, day, count
- `token_usage` — user_id, model, prompt_tokens, completion_tokens, created_at
- `api_keys` — id, user_id, name, key_hash (salted SHA-256), created_at, last_used_at, revoked

## Deploying on the Mac Mini

### 1. Process management (PM2)

```bash
npm install -g pm2
pm2 start ecosystem.config.js      # deepmt-server + deepmt-engine
pm2 save && pm2 startup
```

The engine process runs `~/turbo-fieldfare/.build/release/TurboFieldfareServer`
with a 4K context (start with `--max-context 16384` for Jupiter-sized contexts;
Neptune requests stay small). If the model is not installed yet, keep the
`deepmt-engine` app disabled in `ecosystem.config.js`.

### 2. Firewall

Block everything except the reverse proxy:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
```

### 3. Expose without NAT (Cloudflare Tunnel)

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create deepmt
cloudflared tunnel route dns deepmt chat.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 deepmt
```

HTTPS/SSL is automatic. Never expose the TurboFieldfare loopback server on
:8080 (unauthenticated by design).

## Signature animations

- **Thinking flower** — while waiting for the first token, the 5-petal favicon
  rotates 45° → decelerates → rapid 360° spin → settles (custom cubic-bezier).
- **Terminal cursor** — a teal `|` blinks at the end of the streamed text
  (`step-end` blink) instead of a three-dot loader.

Both live in `client/src/styles/animations.css`.

## Security notes

- Passwords: bcrypt (12 rounds). Tokens: JWT, `sub` = user id.
- API keys: only a salted SHA-256 hash is stored; plaintext is shown once and
  keys are revocable. A revoked key returns `401` immediately.
- Session ownership is enforced on every route (404 for other users' sessions).
- `run_code` is sandboxed: no `require`, no network, no filesystem outside
  `makePdf`; 30 s timeout; output capped at 4 KB.
- Change `JWT_SECRET` in `server/.env` before exposing the server.
