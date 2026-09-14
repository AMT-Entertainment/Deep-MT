#!/usr/bin/env node
/**
 * DeepMT MCP server (stdio).
 *
 * Exposes DeepMT's tools (make_image, make_chart, web_search, get_weather,
 * image understanding, …) to any MCP client — Claude Desktop, Cursor,
 * Zed, VS Code, etc. Tools run through the same `executeTool` pipeline as the
 * chat, so files/images land in the user's private tools-output directory.
 *
 * Usage:
 *   MCP_USER_ID=<user id> node mcp-server.js
 *
 * The user id is used for per-account storage. If unset, tools fall back to
 * the "mcp" sandbox account. Asset URLs are rewritten to absolute
 * http://localhost:3000 links (override with MCP_BASE_URL) so external
 * clients can fetch them.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { executeTool, TOOLS } = require('./tools/tools');
const vision = require('./src/vision');
const { userDir } = require('./src/files');
const fs = require('node:fs');
const path = require('node:path');

const USER_ID = process.env.MCP_USER_ID || 'mcp';
const BASE_URL = (process.env.MCP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

function absolutize(text) {
  return String(text || '').replace(/(\/tools-output\/[^\s)\]]+)/g, `${BASE_URL}$1`);
}

const server = new McpServer({
  name: 'deepmt',
  version: '2.0.0',
});

async function run(name, args) {
  const result = await executeTool(name, args || {}, USER_ID);
  const text = result.ok ? result.content : `⚠ ${result.content}`;
  return { content: [{ type: 'text', text: absolutize(text) }] };
}

const TOOL_ARGS = {
  web_search: ['query'],
  fetch_url: ['url'],
  make_pdf: ['text', 'filename'],
  make_file: ['content', 'filename', 'format'],
  make_site: ['html', 'markdown', 'title', 'filename'],
  make_image: ['prompt', 'style', 'size', 'edit'],
  make_chart: ['type', 'title', 'labels', 'values'],
  get_weather: ['city'],
  get_news: ['query'],
  get_wikipedia: ['topic'],
  run_code: ['code'],
  calculate: ['expression'],
  get_time: [],
  get_system_info: [],
  make_qr: ['text', 'size'],
  convert_currency: ['amount', 'from', 'to'],
  get_crypto: ['coin', 'currency'],
  get_astronomy: ['city'],
  define_word: ['word'],
  make_diagram: ['type', 'title', 'steps'],
  generate_password: ['length'],
  check_uptime: ['url', 'method'],
  get_dns: ['domain', 'type'],
  ocr_image: ['image'],
};

for (const [name, args] of Object.entries(TOOL_ARGS)) {
  const tool = TOOLS[name];
  if (!tool) continue;
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: z.object(Object.fromEntries(args.map((a) => [a, z.any().optional()]))),
    },
    (params) => run(name, params),
  );
}

server.registerTool(
  'understand_image',
  {
    description:
      'Describe an image the user uploaded to DeepMT. Arguments: {"file": "the /tools-output image URL from a previous tool result"} or {"prompt": "optional extra question about the image"}. Uses the local vision model (llava) via Ollama.',
    inputSchema: z.object({
      file: z.string().optional(),
      prompt: z.string().optional(),
    }),
  },
  async (params) => {
    const file = String(params.file || '');
    const fileName = path.basename(file.split('?')[0]);
    const dir = userDir(USER_ID);
    const full = path.join(dir, fileName);
    if (!fs.existsSync(full)) {
      return { content: [{ type: 'text', text: `⚠ Image not found (${file}). Images are stored per user; set MCP_USER_ID to the owner's id.` }] };
    }
    try {
      const description = await vision.describeImage(USER_ID, fileName, params.prompt || '');
      return { content: [{ type: 'text', text: description }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `⚠ ${err.message}` }] };
    }
  },
);

server.registerTool(
  'attach_image',
  {
    description:
      'Attach a local image file so later tools can reference it. Arguments: {"path": "absolute path to an image on this machine"}. Returns a /tools-output URL usable as the "edit" argument of make_image or "file" of understand_image.',
    inputSchema: z.object({
      path: z.string(),
    }),
  },
  async (params) => {
    const src = String(params.path || '');
    try {
      const buf = fs.readFileSync(src);
      const ext = path.extname(src).toLowerCase() || '.png';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
      const name = `up-${stamp}-${Math.random().toString(36).slice(2, 7)}${ext}`;
      const dir = userDir(USER_ID);
      fs.writeFileSync(path.join(dir, name), buf);
      return {
        content: [{ type: 'text', text: `${BASE_URL}/tools-output/${path.basename(dir)}/${name}` }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `⚠ ${err.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error(`[mcp] DeepMT server ready — user: ${USER_ID}, base: ${BASE_URL}`);
});
