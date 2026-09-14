# DeepMT Desktop

A native Electron companion app to the DeepMT site. Separate from the web client — it runs
**fully local** against your own Ollama instance, with deep privileges the browser can't give:

## Tabs

| Tab | What it does |
|-----|--------------|
| 💬 Chat | Streaming chat with the local URANUS model (llama3.1). |
| 🛠 [MT] Host Agent | Gives URANUS **real** machine access: run shell commands, read/write/list files on **your Mac**. Every action is shown and must be approved live. |
| 👁 TAKE OVER | A vision model (llava) screenshots your screen, decides the next click / keystroke / scroll, and (with your approval) drives your mouse & keyboard to complete your goal. |

## Requirements

- macOS (arm64 tested), a local Ollama at `http://127.0.0.1:11434`
- Models: `llama3.1:latest` (chat/[MT]) and `llava:latest` (vision) — install via
  `ollama pull llama3.1 && ollama pull llava`
- First TAKE OVER run: grant the app **Screen Recording** + **Accessibility**
  permissions in System Settings → Privacy & Security.

## Run

```sh
cd desktop
npm install
npm start        # or: npx electron .
```

## Layout

```
main.js            Electron main — Ollama streaming, host tools, [MT] loop, TAKE OVER loop
preload.js         contextBridge API (window.deepmt.*)
renderer/          UI — index.html, styles.css, app.js
tools/             inputctl (Swift CGEvent) — click/scroll/type/key without extra native libs
```

## Safety

- Every [MT] tool call and each TAKE OVER action is rendered with an Allow / Block prompt.
- A global **■ STOP** in the header halts the active loop instantly.
- Destructive commands (rm -rf /, mkfs, reboot, …) are refused outright in [MT].

The workspace dir is `~/DeepMT-Workspace` (auto-created).