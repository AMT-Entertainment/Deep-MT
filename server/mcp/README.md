# DeepMT MCP server

Exposes DeepMT's tools to any MCP client (Claude Desktop, Cursor, Zed, VS Code
Copilot, …) over stdio: `make_image`, `make_chart`, `make_file`, `make_pdf`,
`web_search`, `fetch_url`, `get_weather`, `get_news`, `get_wikipedia`,
`run_code`, `calculate`, `get_time`, `get_system_info`, plus two custom tools:

- **`understand_image`** — describe/answer questions about an image stored on
  DeepMT (local vision model via Ollama — `llava`).
- **`attach_image`** — import a local image by path so other tools can use it
  (as `make_image.edit` or `understand_image.file`).

## Prerequisites

- DeepMT server running (`npm start`) — the tools write assets into the
  per-user `tools-output/` dirs served at `http://localhost:3000`.
- Set `MCP_USER_ID` to the account whose files you want to scope the tools to
  (default: `mcp`). `MCP_BASE_URL` defaults to `http://localhost:3000`; change
  it if the server is on another host/port.
- For vision: `ollama pull llava`.

## Run

```bash
MCP_USER_ID=<some user id> npm run mcp
```

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "deepmt": {
      "command": "node",
      "args": ["/Users/macmini/Desktop/deep MT/server/mcp-server.js"],
      "env": { "MCP_USER_ID": "mcp" }
    }
  }
}
```

## Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "deepmt": {
      "command": "node",
      "args": ["/Users/macmini/Desktop/deep MT/server/mcp-server.js"],
      "env": { "MCP_USER_ID": "mcp" }
    }
  }
}
```

## Notes

- Commands are one tool per turn, like the chat — pass the needed arguments and
  let the tool return a file URL.
- Tool results and file URLs are rewritten to absolute `MCP_BASE_URL` links so
  external clients can open them in a browser.
- Everything runs on the same machine; no keys, no cloud.