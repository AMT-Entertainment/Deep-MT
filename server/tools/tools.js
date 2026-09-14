/**
 * DeepMT tool implementations for MT 1.0 Jupiter.
 * Protocol documented in ./README.md.
 */
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const net = require('node:net');
const { lookup } = require('node:dns').promises;
const { renderMarkdownPdf } = require('./md2pdf');
const imagegen = require('../src/imagegen');
const { userDir, registerImage } = require('../src/files');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TOOLS = {
  web_search: {
    description:
      'Search the public web. Arguments: {"query": "short keyword phrase"}. Returns up to 5 results with title, url, snippet. If one search engine is unavailable it automatically tries another.',
    run: webSearch,
  },
  fetch_url: {
    description:
      'Fetch a public web page and return its readable text. Arguments: {"url": "https://example.com/page"}. Use after web_search to read an article. Returns up to 8 KB of text; 20 s timeout.',
    run: fetchUrl,
  },
  make_pdf: {
    description:
      'Create a styled PDF from Markdown. Arguments: {"text": "document with markdown (# headings, **bold**, *italic*, - lists, ``` code fences, > quotes)", "filename": "optional base name without extension"}. Returns a download URL to give the user. Use for reports, notes, summaries.',
    run: makePdfTool,
  },
  make_file: {
    description:
      'Write a text file the user can download/keep. Arguments: {"content": "full file text", "filename": "base name", "format": "md | txt | csv"} (format optional, defaults to markdown). Returns a download URL. Use for notes, raw markdown, data tables, configs.',
    run: makeFileTool,
  },
  make_site: {
    description:
      'Build a simple HTML website for the user (the "Archives" feature) and show it live. Arguments: {"html": "full HTML for the page" OR "markdown": "page content in markdown", "title": "page heading", "filename": "optional base name"}. A styled page is written to the user\'s archive folder and previewed in the Archives panel on the right. Use for landing pages, portfolios, notes sites, docs, dashboards — anything a small HTML page can express.',
    run: makeSiteTool,
  },
  make_image: {
    description:
      'Generate or edit an image. Arguments: {"prompt": "detailed description", "style": "optional keyword — e.g. photo, painting, anime, cyberpunk", "size": "512 | 1024" (optional longest edge), "edit": "optional — an exact /tools-output image URL from the conversation when the user wants to modify an existing picture"}. Renders a real PNG via Stable Diffusion and returns a URL to view/download. Use 1024 for detailed shots, 512 for quick subjects. Edits keep the source image\'s aspect ratio (never stretched).',
    run: makeImageTool,
  },
  make_chart: {
    description:
      'Create a chart image from data. Arguments: {"type": "bar | line | pie", "title": "optional heading", "labels": ["Q1","Q2"], "values": [10, 25]}. Renders an SVG chart and returns a URL. Use for summarizing numbers visually.',
    run: makeChartTool,
  },
  get_weather: {
    description:
      'Get current weather for a city. Arguments: {"city": "e.g. Lisbon"}. Returns temperature, condition, wind, humidity. Europe-focused but works worldwide.',
    run: getWeather,
  },
  get_news: {
    description:
      'Get recent news headlines. Arguments: {"query": "optional topic, e.g. AI chips"}. Returns up to 6 headlines with source and publish time. Use for current events.',
    run: getNews,
  },
  get_wikipedia: {
    description:
      'Get a concise summary of a Wikipedia topic. Arguments: {"topic": "e.g. Mixture of experts"}. Returns the lead section of the article. Use for quick factual overviews.',
    run: getWikipedia,
  },
  run_code: {
    description:
      'Run a small JavaScript program in a sandbox. Arguments: {"code": "self-contained JS"}. Helpers: makePdf(text, filename) renders Markdown to a styled PDF; result(value) returns output. No network or filesystem access.',
    run: runCode,
  },
  calculate: {
    description:
      'Evaluate a safe arithmetic expression. Arguments: {"expression": "e.g. 2*21+9 or sqrt(144)+3**2"}. Supports + - * / % ** parentheses and Math functions (sqrt, abs, floor, ceil, round, pow, min, max, log, exp, sin, cos, tan, pi, e). Returns the numeric result.',
    run: calculate,
  },
  get_time: {
    description:
      'Get the current date and time on the DeepMT server, shown in the requester\'s local timezone whenever the browser reported one. Arguments: {}.',
    run: (_args, _userId, ctx) => formatInTimezone(new Date(), ctx && ctx.timezone),
  },
  get_system_info: {
    description:
      'Get DeepMT server details: hostname, platform, CPU, memory, uptime, load and engine status. Arguments: {}. Use when the user asks about the machine or the servers.',
    run: getSystemInfo,
  },
  make_qr: {
    description:
      'Create a QR code image from any text or URL. Arguments: {"text": "the link or text to encode", "size": "optional pixel size (default 512)"}. Writes an SVG and returns a URL to view/download. Use for sharing links, Wi-Fi logins, contact cards.',
    run: makeQrTool,
  },
  convert_currency: {
    description:
      'Convert money between currencies at current exchange rates (ECB daily rates). Arguments: {"amount": 100, "from": "USD", "to": "EUR"}. Codes like USD, EUR, GBP, JPY, CHF, BRL. Use for price comparisons and travel math.',
    run: convertCurrency,
  },
  get_crypto: {
    description:
      'Get a live cryptocurrency price with 24h change. Arguments: {"coin": "bitcoin | ethereum | solana | dogecoin ...", "currency": "optional, default usd"}. Use for any crypto price question.',
    run: getCrypto,
  },
  get_astronomy: {
    description:
      'Get astronomy info for a city: sunrise, sunset, daylight length and moon phase. Arguments: {"city": "e.g. Reykjavik"}. Use for sky, light and moon questions.',
    run: getAstronomy,
  },
  define_word: {
    description:
      'Look up an English word: part of speech, definitions and examples. Arguments: {"word": "e.g. serendipity"}. Use for dictionary and vocabulary questions.',
    run: defineWord,
  },
  make_diagram: {
    description:
      'Create a diagram image. Arguments: {"type": "flow | sequence | mindmap", "title": "optional heading", "steps": ["step 1", "step 2", ...]}. Renders a clean SVG and returns a URL. Use to visualize processes, timelines, ideas or hierarchies.',
    run: makeDiagramTool,
  },
  generate_password: {
    description:
      'Generate a strong random password. Arguments: {"length": "optional, default 16 (8-64)"}. Returns the password — copy it into the reply so the user can copy it.',
    run: generatePassword,
  },
  check_uptime: {
    description:
      'Check whether a website is up: status code and response time. Arguments: {"url": "https://example.com", "method": "optional HEAD | GET, default HEAD"}. Use when the user asks if a site is down or slow.',
    run: checkUptime,
  },
  get_dns: {
    description:
      'Resolve DNS records for a domain. Arguments: {"domain": "example.com", "type": "optional A | AAAA | MX | NS | TXT, default A"}. Uses Google Public DNS over HTTPS (no key). Use for domain and hosting questions.',
    run: getDns,
  },
  ocr_image: {
    description:
      'Read text out of an image. Arguments: {"image": "an exact /tools-output image URL from the conversation"}. Uses the local vision model to transcribe visible text. Use for screenshots, photos of documents and text-heavy images.',
    run: ocrImage,
  },
};

function toolDescriptionBlock() {
  return [
    'You have tools. When the user request matches one, emit exactly one line: <tool:NAME>{"arg":"value"}</tool:NAME>.',
    'Call ONE tool at a time: emit it, wait for the result, then continue. Handle several needs sequentially.',
    'For files (PDF / markdown / text / CSV / image) you MUST call the matching tool and report the exact returned URL. Never invent links or claim a tool ran.',
    'Available tools:',
    '  web_search — {"query"} — search the web, up to 5 results',
    '  fetch_url — {"url"} — read a web page as plain text (8 KB)',
    '  make_pdf — {"text","filename"?} — styled PDF rendered from markdown',
    '  make_file — {"content","filename"?, "format"?} — save md/txt/csv file',
    '  make_site — {"html"|"markdown","title"?,"filename"?} — build a simple HTML site (Archives) that previews live; report the exact URL',
    '  make_image — {"prompt","style"?,"size"?,"edit"?} — PNG via Stable Diffusion; size 512 or 1024 (longest edge, choose 1024 for detailed shots); set "edit" to the exact /tools-output image URL when the user wants to modify an existing image (the result keeps the source aspect ratio); report the exact URL',
    '  make_chart — {"type","title"?, "labels"?,"values"} — bar/line/pie chart image from data',
    '  get_weather — {"city"} — current weather for a city',
    '  get_news — {"query"?} — recent news headlines',
    '  get_wikipedia — {"topic"} — concise article summary',
    '  run_code — {"code"} — sandboxed JS; helpers makePdf(text,name) and result(v)',
    '  calculate — {"expression"} — safe arithmetic',
    '  get_time — {} — current server time',
    '  get_system_info — {} — server host/CPU/memory/engine status',
    '  make_qr — {"text","size"?} — QR code SVG from text/URL',
    '  convert_currency — {"amount","from","to"} — live FX conversion (ECB rates)',
    '  get_crypto — {"coin","currency"?} — live crypto price + 24h change',
    '  get_astronomy — {"city"} — sunrise/sunset/daylight/moon phase for a city',
    '  define_word — {"word"} — dictionary definitions and examples',
    '  make_diagram — {"type","title"?, "steps"} — flow/sequence/mindmap SVG from steps',
    '  generate_password — {"length"?} — strong random password',
    '  check_uptime — {"url","method"?} — status code + response time of a site',
    '  get_dns — {"domain","type"?} — DNS records via Google DNS',
    '  ocr_image — {"image"} — transcribe text from a /tools-output image URL',
    'After each tool result arrives, continue your answer and present the outcome to the user.',
    'For generated files and images you MUST show the exact returned URL to the user (as a link or markdown image).',
  ].join('\n');
}

/**
 * Finds every complete tool call in text. Tolerant of the small format slips
 * the models actually produce:
 *
 *   <tool:get_time>{}</tool:get_time>
 *   <tool:get_time:{}></tool:get_time>
 *   <tool:make_chart>{"type":"bar",...}</tool:call:make_chart>   (wrong closing tag)
 *   <tool:run_code>{"code":"x"}                                   (no closing tag)
 *   <tool:make_chart>{"type":"bar",...}
 *
 * Args are located as the first balanced {...} (or [...]) block after the tag,
 * so stray punctuation between the name and the JSON never breaks parsing.
 */
function extractToolCalls(text) {
  const calls = [];
  let idx = 0;
  while (idx < text.length) {
    const lt = text.indexOf('<tool:', idx);
    if (lt === -1) break;
    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(text.slice(lt + '<tool:'.length));
    if (!nameMatch) {
      idx = lt + '<tool:'.length;
      continue;
    }
    const name = nameMatch[0];
    // Locate the balanced args block (first { or [ after the tag).
    let argsStart = -1;
    let openCh = '';
    const windowEnd = Math.min(text.length, lt + '<tool:'.length + name.length + 500);
    for (let i = lt + '<tool:'.length + name.length; i < windowEnd; i++) {
      const c = text[i];
      if (c === '{' || c === '[') {
        argsStart = i;
        openCh = c;
        break;
      }
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== ':' && c !== '>' && c !== '`') {
        idx = i + 1;
        break;
      }
    }
    if (argsStart === -1) {
      // Tools with no arguments may be emitted without braces:
      // <tool:get_time></tool:get_time> or <tool:get_system_info></tool:get_system_info>
      const closeIdx = text.indexOf(`</tool:${name}>`, lt + 6);
      const closeLoose = text.indexOf(`</tool:call:${name}>`, lt + 6);
      const stop = closeIdx === -1 ? closeLoose : closeLoose === -1 ? closeIdx : Math.min(closeIdx, closeLoose);
      if (stop === -1 || stop > lt + 160) {
        idx = lt + '<tool:'.length + name.length;
        continue;
      }
      const gt = text.indexOf('>', stop);
      const fullEnd = gt === -1 || gt > stop + 40 ? stop + `</tool:${name}>`.length : gt + 1;
      calls.push({ name, args: {}, full: text.slice(lt, fullEnd) });
      idx = fullEnd;
      continue;
    }
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = argsStart; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      idx = argsStart + 1;
      continue;
    }
    const argsValue = text.slice(argsStart, end + 1);
    // Consume any closing tag directly after the args (e.g. </tool:name> or
    // </tool:call:name>) so the whole marker strips as one unit.
    const afterStart = end + 1;
    const afterEnd = text.slice(afterStart, afterStart + 80);
    let fullEnd = end + 1;
    if (afterEnd.indexOf('<') !== -1) {
      const gt = text.indexOf('>', afterStart + afterEnd.indexOf('<'));
      if (gt !== -1 && gt < afterStart + 80) fullEnd = gt + 1;
    }
    calls.push({
      name,
      args: parseArgs(argsValue),
      full: text.slice(lt, fullEnd),
    });
    idx = fullEnd;
  }
  return calls;
}

/** Parses args that may be strict JSON or loose key:value pairs. */
function parseArgs(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: String(parsed) };
  } catch {
    /* fall through to loose parsing */
  }
  const args = {};
  for (const pair of raw.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:)/)) {
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(pair);
    if (m) args[m[1]] = m[2].replace(/^["']|["']$/g, '');
    else if (pair.trim()) args.value = (args.value ? args.value + ', ' : '') + pair.trim();
  }
  return args;
}

/** Returns the first complete tool call, or null. */
function extractToolCall(text) {
  return extractToolCalls(text)[0] || null;
}

/** Removes all tool markers from text (used before display/persistence). */
function stripToolCalls(text) {
  let out = text;
  for (const call of extractToolCalls(text)) {
    out = out.replace(call.full, '');
  }
  return out.trim();
}

/**
 * Formats a Date for a given IANA time zone ("America/New_York"), with the
 * UTC offset spelled out, e.g. "Friday, August 7, 2026 at 12:34:56 PM
 * (America/New_York, GMT-04:00). ISO: 2026-08-07T16:34:56.000Z".
 * Falls back to plain UTC ISO when the zone is missing or invalid.
 */
function formatInTimezone(date, timezone) {
  if (!timezone) return date.toISOString();
  try {
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    }).format(date);
    let offset = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(date);
      const piece = parts.find((p) => p.type === 'timeZoneName');
      if (piece) offset = ' ' + piece.value.replace('GMT', 'GMT');
    } catch { /* offset is cosmetic */ }
    return `${local} (${timezone}${offset}). ISO: ${date.toISOString()}`;
  } catch {
    return date.toISOString();
  }
}

/**
 * Tool registry — one entry per tool.
 *   run(args, userId, ctx) — ctx carries per-request context (e.g. timezone).
 */
async function executeTool(name, args, userId, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, content: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` };
  try {
    const content = await tool.run(args || {}, userId, ctx || {});
    // Keep engine prompts small: results are summaries, not raw dumps.
    const capped = String(content).slice(0, 1500);
    const result = { ok: true, content: capped + (capped.length < String(content).length ? '\n…(truncated)' : '') };
    // Surface the generated asset so the chat can render it inline.
    const asset = String(content).match(/\/tools-output\/[^\s)]+\.(?:png|svg|pdf|md|txt|csv|html)/i);
    if (asset) result.assetUrl = asset[0];
    if (name === 'make_image' && result.assetUrl) result.imageUrl = result.assetUrl;
    if (name === 'make_site' && result.assetUrl) result.siteUrl = result.assetUrl;
    return result;
  } catch (err) {
    return { ok: false, content: `Tool ${name} failed: ${err.message}` };
  }
}

/* ---------------- web_search (multi-backend fallback) ---------------- */

const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

function decodeDdgHref(href) {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    if (parsed.searchParams.get('uddg')) return parsed.searchParams.get('uddg');
  } catch {
    /* keep raw */
  }
  return href;
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    const key = (r.url || '').replace(/\/$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksBlocked(body) {
  return !body || /anomaly|unusual traffic|robot.check|captcha/i.test(body.slice(0, 3000));
}

async function searchDdgHtml(query) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 200))}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const html = await res.text();
  if (looksBlocked(html)) throw new Error('search engine blocked this request');

  const norm = html.replace(/class='/g, 'class="');
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors = [...norm.matchAll(anchorRe)];
  const snippets = [...norm.matchAll(snippetRe)];
  const results = [];
  for (let i = 0; i < anchors.length && results.length < 5; i++) {
    const [, href, titleHtml] = anchors[i];
    results.push({
      title: strip(titleHtml),
      url: decodeDdgHref(href),
      snippet: snippets[i] ? strip(snippets[i][1]).slice(0, 300) : '',
    });
  }
  return dedupe(results);
}

async function searchDdgLite(query) {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query.slice(0, 200))}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const html = await res.text();
  if (looksBlocked(html)) throw new Error('search engine blocked this request');

  const anchors = [
    ...html.replace(/class='/g, 'class="').matchAll(/<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  const snippets = [
    ...html.replace(/class='/g, 'class="').matchAll(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g),
  ];
  const results = [];
  for (let i = 0; i < anchors.length && results.length < 5; i++) {
    const [, href, titleHtml] = anchors[i];
    results.push({
      title: strip(titleHtml),
      url: decodeDdgHref(href),
      snippet: snippets[i] ? strip(snippets[i][1]).slice(0, 300) : '',
    });
  }
  return dedupe(results);
}

async function searchBing(query) {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query.slice(0, 200))}&count=10`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const html = await res.text();
  if (!html.includes('b_algo')) throw new Error('search engine blocked this request');

  const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)]
    .map((m) => m[0])
    .filter((b) => /<h2>/.test(b));
  const results = [];
  for (const block of blocks) {
    const titleM = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleM) continue;
    const snippetM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({
      title: strip(titleM[2]).slice(0, 150),
      url: decodeBingHref(titleM[1]),
      snippet: snippetM ? strip(snippetM[1]).slice(0, 300) : '',
    });
    if (results.length >= 5) break;
  }
  return dedupe(results);
}

function decodeBingHref(href) {
  try {
    const parsed = new URL(href, 'https://www.bing.com');
    if (parsed.hostname.includes('bing.com') && parsed.pathname.includes('/ck/')) {
      const u = parsed.searchParams.get('u');
      if (u) {
        const decoded = Buffer.from(u.replace(/^a1/, ''), 'base64').toString('utf8');
        if (decoded.startsWith('http')) return decoded;
      }
    }
    if (parsed.hostname.includes('bing.com') && !parsed.pathname.includes('/ck/')) return href;
    if (parsed.hostname.includes('bing.com')) return href;
    return parsed.toString();
  } catch {
    return href;
  }
}

async function webSearch({ query }) {
  if (!query || typeof query !== 'string') throw new Error('A query string is required');
  const engines = [searchDdgHtml, searchDdgLite, searchBing];
  let lastError = 'no results found';
  for (const engine of engines) {
    try {
      const results = await engine(query);
      if (results.length > 0) return JSON.stringify(results, null, 2);
    } catch (err) {
      lastError = err.message;
    }
  }
  return `No results found (${lastError}). Try a different query.`;
}

/* ---------------- make_pdf (Markdown -> styled PDF) ---------------- */

/** Resolves a user's private output directory + URL prefix (owner-scoped). */
function outPath(userId) {
  const dir = userDir(userId);
  const urlBase = `/tools-output/${path.basename(dir)}`;
  return { dir, urlBase };
}

function writePdf(text, safeName, userId) {
  return new Promise((resolve, reject) => {
    const PDFDocument = require('pdfkit');
    const { dir, urlBase } = outPath(userId);
    const file = path.join(dir, safeName + '.pdf');
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const stream = fs.createWriteStream(file);
    stream.on('finish', () => resolve({ url: `${urlBase}/${safeName}.pdf`, file }));
    stream.on('error', reject);
    doc.pipe(stream);
    renderMarkdownPdf(doc, String(text));
    doc.end();
  });
}

function safeBaseName(name) {
  return String(name || 'output').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60);
}

async function makePdfTool({ text, filename }, userId) {
  if (!text || typeof text !== 'string') throw new Error('A text string is required');
  const safe = safeBaseName(filename);
  const { url } = await writePdf(text, safe, userId);
  return `PDF written: ${url}`;
}

/* ---------------- make_file (markdown / text / csv) ---------------- */

function makeFileTool({ content, filename, format }, userId) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('A content string is required');
  const ext = String(format || 'markdown').toLowerCase() === 'csv' ? 'csv' : String(format || '').toLowerCase() === 'txt' ? 'txt' : 'md';
  const safe = safeBaseName(filename || 'document');
  const { dir, urlBase } = outPath(userId);
  const file = path.join(dir, `${safe}.${ext}`);
  const body = ext === 'csv' ? String(content).replace(/\r?\n/g, '\n').replace(/^\s+|\s+$/g, '') : String(content);
  fs.writeFileSync(file, body.endsWith('\n') ? body : body + '\n');
  return `File written: ${urlBase}/${safe}.${ext}`;
}

/* ---------------- make_file (markdown / text / csv) ---------------- */

/* ---------------- make_site (basic HTML archive) ---------------- */

const ARCHIVE_CSS = `
:root{color-scheme:light dark;}
*{box-sizing:border-box;}
body{margin:0;font-family:-apple-system,'Segoe UI',Inter,system-ui,sans-serif;line-height:1.6;color:#1f2937;background:#f6f7f9;}
a{color:#0f766e;}
.container{max-width:820px;margin:0 auto;padding:32px 22px 64px;}
.site-hero{padding:34px 22px;border-radius:18px;background:linear-gradient(135deg,#0f766e,#115e59 55%,#0e1512);color:#fff;margin-bottom:28px;}
.site-hero h1{margin:0 0 6px;font-size:2rem;}
.site-hero p{margin:0;opacity:.85;}
.site-tag{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.16);font-size:.78rem;margin-bottom:12px;}
.site-section{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px 22px;margin:16px 0;box-shadow:0 4px 14px rgba(0,0,0,.05);}
.site-section h2{margin:0 0 10px;font-size:1.25rem;color:#0f766e;}
.site-section h3{color:#115e59;}
.site-section ul{padding-left:20px;}
.site-section li{margin:4px 0;}
.site-section pre{background:#0e1512;color:#d1fae5;padding:14px 16px;border-radius:10px;overflow:auto;font-size:.85rem;}
.site-section code{font-family:'SF Mono',Menlo,monospace;background:#eef2f1;padding:1px 6px;border-radius:6px;font-size:.86em;}
.site-section pre code{background:none;padding:0;color:inherit;}
.site-footer{text-align:center;color:#6b7280;font-size:.8rem;margin-top:34px;}
@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#0d1117;} .site-section{background:#161b22;border-color:#30363d;} .site-section code{background:#21262d;}}
`;

/** Renders a standalone HTML page; returns its path + URL. */
function makeSite({ html, markdown, title, filename }, userId) {
  const safe = safeBaseName(filename || title || 'site');
  const { dir, urlBase } = outPath(userId);
  const file = path.join(dir, `${safe}.html`);
  let doc;
  if (html && typeof html === 'string' && html.trim()) {
    doc = String(html);
    if (!/<\/html>/i.test(doc)) {
      const head = doc.replace(/<body[^>]*>/i, '');
      doc =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escXml(title || safe)}</title><style>${ARCHIVE_CSS}</style></head><body>` +
        `<div class="container">${head}</div></body></html>`;
    }
  } else if (markdown && typeof markdown === 'string' && markdown.trim()) {
    const body = String(markdown)
      .replace(/^###[ \t]+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##[ \t]+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#[ \t]+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^\s*[-*][ \t]+(.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?)(\n<li>)/g, '$1$2')
      .replace(/^((?:<li>.*\n?)+)/gm, '<ul>$1</ul>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^\[([^\]]+)\]\(([^)]+)\)$/gm, '<a href="$2">$1</a>')
      .replace(/^\s*([^<\s][^\n]*)$/gm, '<p>$1</p>');
    doc =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escXml(title || safe)}</title><style>${ARCHIVE_CSS}</style></head><body>` +
      `<div class="container"><div class="site-hero"><span class="site-tag">Archives</span>` +
      `<h1>${escXml(title || safe)}</h1><p>Generated by DeepMT</p></div>` +
      `<div class="site-section">${body}</div>` +
      `<div class="site-footer">Made with DeepMT · Archives</div></div></body></html>`;
  } else {
    throw new Error('Provide "html" (a page) or "markdown" (content) to build the site');
  }
  fs.writeFileSync(file, doc);
  return `${urlBase}/${safe}.html`;
}

async function makeSiteTool(args, userId) {
  const url = makeSite(args, userId);
  return `Site written: ${url} — the user can preview it live in the Archives panel, open it, or download the HTML.`;
}

/* ---------------- make_image (instant SVG scenes, zero GPU) ---------------- */

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escXml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function sceneSunset(r) {
  const lay = (y, h, c, o) => `<path d="M0 ${y} Q112 ${y - h} 225 ${y} T450 ${y} T675 ${y} T900 ${y} L900 506 L0 506 Z" fill="${c}" opacity="${o}"/>`;
  return {
    defs:
      '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#101a3d"/><stop offset="0.45" stop-color="#5c2a63"/><stop offset="0.72" stop-color="#e2624f"/><stop offset="1" stop-color="#f6b35c"/></linearGradient>' +
      '<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe9a8"/><stop offset="0.55" stop-color="#ffb45e" stop-opacity="0.95"/><stop offset="1" stop-color="#ffb45e" stop-opacity="0"/></radialGradient>',
    body:
      '<rect width="900" height="506" fill="url(#sky)"/>' +
      `<circle cx="450" cy="300" r="170" fill="url(#sun)"/>` +
      `<circle cx="450" cy="300" r="58" fill="#ffe9a8"/>` +
      lay(318, 46, '#3c2b52', 0.9) +
      lay(344, 38, '#53335e', 0.95) +
      lay(380, 42, '#7c3b52', 1) +
      lay(424, 52, '#b04f47', 1) +
      lay(466, 60, '#f28c4f', 1),
  };
}

function sceneMountains(r) {
  const range = (base, amp, cols, o) => {
    let pts = ['0 506'];
    let x = 0;
    while (x < 920) {
      const peak = 200 + r() * 130;
      pts.push(`${x} ${base - peak}`);
      x += 170 + r() * 120;
      pts.push(`${x} ${base - r() * 60}`);
    }
    pts.push('900 506');
    return `<polygon points="${pts.join(' ')}" fill="${cols[Math.floor(r() * cols.length)]}" opacity="${o}"/>`;
  };
  return {
    defs:
      '<linearGradient id="skym" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0e1b3d"/><stop offset="0.5" stop-color="#25406e"/><stop offset="0.8" stop-color="#b06a86"/><stop offset="1" stop-color="#f3c78d"/></linearGradient>' +
      '<radialGradient id="sunm" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3d6"/><stop offset="1" stop-color="#fff3d6" stop-opacity="0"/></radialGradient>',
    body:
      '<rect width="900" height="506" fill="url(#skym)"/>' +
      '<circle cx="660" cy="330" r="150" fill="url(#sunm)"/>' +
      '<circle cx="660" cy="330" r="52" fill="#ffe9b8"/>' +
      range(420, 110, ['#1c2a4d', '#233459'], 0.95) +
      range(340, 130, ['#2b3f68', '#35507e'], 1) +
      range(300, 90, ['#45557e'], 1),
  };
}

function sceneSpace(r) {
  let stars = '';
  for (let i = 0; i < 140; i++) {
    const x = Math.floor(r() * 900);
    const y = Math.floor(r() * 506);
    const s = 1 + r() * 2.2;
    const o = 0.2 + r() * 0.8;
    stars += `<circle cx="${x}" cy="${y}" r="${s.toFixed(1)}" fill="#fff" opacity="${o.toFixed(2)}"/>`;
  }
  const blob = (cx, cy, rx, c) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * 0.55}" fill="${c}" filter="url(#blur)" opacity="0.55"/>`;
  return {
    defs:
      '<linearGradient id="sp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#04050f"/><stop offset="1" stop-color="#181140"/></linearGradient>' +
      '<radialGradient id="moon" cx="0.35" cy="0.35" r="0.75"><stop offset="0" stop-color="#cfd4ff"/><stop offset="0.6" stop-color="#5b4d8f"/><stop offset="1" stop-color="#2c2454"/></radialGradient>' +
      '<filter id="blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="36"/></filter>',
    body:
      '<rect width="900" height="506" fill="url(#sp)"/>' +
      blob(240, 160, 200, '#5b3fa0') +
      blob(700, 340, 230, '#1f5f8f') +
      blob(480, 420, 180, '#8f2f6b') +
      `<circle cx="700" cy="140" r="64" fill="url(#moon)"/>` +
      stars +
      `<ellipse cx="700" cy="140" rx="96" ry="26" fill="none" stroke="#8f9bd8" stroke-width="2.5" opacity="0.8" transform="rotate(-24 700 140)"/>` +
      `<ellipse cx="700" cy="140" rx="120" ry="32" fill="none" stroke="#6b77b8" stroke-width="1.4" opacity="0.5" transform="rotate(-24 700 140)"/>`,
  };
}

function sceneWaves(r) {
  let layers = '';
  let phase = 0;
  for (let i = 0; i < 6; i++) {
    const y0 = 330 + i * 30;
    const a = 14 + r() * 26;
    const col = ['#0f4c5c', '#155e6d', '#1b7180', '#238997', '#2ea3a8', '#ffd166'][i];
    let d = '';
    const n = 9;
    for (let x = 0; x <= n; x++) {
      const px = (x / n) * 900;
      const py = y0 + Math.sin((x / n) * Math.PI * 3 + phase) * a;
      d += (x === 0 ? 'M' : ' L') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    layers += `<path d="${d} L900 506 L0 506 Z" fill="${col}" opacity="${0.5 + i * 0.1}"/>`;
    phase += 0.55;
  }
  return {
    defs:
      '<linearGradient id="wy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06212f"/><stop offset="0.6" stop-color="#0a3a4f"/><stop offset="1" stop-color="#0c4c60"/></linearGradient>' +
      '<radialGradient id="wn" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe8b0"/><stop offset="1" stop-color="#ffe8b0" stop-opacity="0"/></radialGradient>',
    body:
      '<rect width="900" height="506" fill="url(#wy)"/>' +
      '<circle cx="450" cy="180" r="120" fill="url(#wn)" opacity="0.85"/>' +
      `<circle cx="450" cy="180" r="46" fill="#ffe8b0"/>` +
      layers,
  };
}

function sceneNeon(r) {
  let grid = '';
  const horizon = 300;
  for (let i = -10; i <= 10; i++) {
    const x = 450 + i * 60;
    const topX = 450 + i * 150;
    grid += `<line x1="${topX}" y1="0" x2="${x}" y2="${horizon}" stroke="#2b1b54" stroke-width="1.5"/>`;
  }
  for (let j = 0; j < 9; j++) {
    const y = horizon - (j / 9) * horizon;
    const spread = 60 + j * 55;
    grid += `<line x1="${450 - spread}" y1="${y}" x2="${450 + spread}" y2="${y}" stroke="#2b1b54" stroke-width="1.5"/>`;
  }
  return {
    defs:
      '<linearGradient id="ng" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0714"/><stop offset="0.7" stop-color="#150a2e"/><stop offset="1" stop-color="#20063d"/></linearGradient>' +
      '<radialGradient id="ns" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ff4fd8"/><stop offset="0.45" stop-color="#ff4fd8" stop-opacity="0.9"/><stop offset="1" stop-color="#ff4fd8" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="nline" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00e5ff"/><stop offset="0.5" stop-color="#b86bff"/><stop offset="1" stop-color="#ff4fd8"/></linearGradient>' +
      '<filter id="nglow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>',
    body:
      '<rect width="900" height="506" fill="url(#ng)"/>' +
      grid +
      `<circle cx="450" cy="${horizon}" r="150" fill="url(#ns)" opacity="0.9"/>` +
      `<circle cx="450" cy="${horizon}" r="58" fill="#ff7ae0"/>` +
      '<rect x="0" y="300" width="900" height="5" fill="url(#nline)" filter="url(#nglow)"/>' +
      '<rect x="0" y="300" width="900" height="2" fill="url(#nline)"/>' +
      `<rect x="0" y="${horizon}" width="900" height="206" fill="#0d0718" opacity="0.85"/>` +
      '<rect x="0" y="304" width="900" height="202" fill="#0d0718" opacity="0.95"/>',
  };
}

function sceneAbstract(r) {
  const palette = ['#7c3aed', '#ec4899', '#06b6d4', '#f59e0b', '#22c55e'];
  let blobs = '';
  for (let i = 0; i < 9; i++) {
    const cx = 80 + r() * 740;
    const cy = 60 + r() * 380;
    const rx = 60 + r() * 170;
    const c = palette[Math.floor(r() * palette.length)];
    blobs += `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${(rx * 0.5).toFixed(0)}" fill="${c}" filter="url(#ablur)" opacity="0.4"/>`;
  }
  let sparks = '';
  for (let i = 0; i < 40; i++) {
    sparks += `<circle cx="${(r() * 900).toFixed(0)}" cy="${(r() * 506).toFixed(0)}" r="${(1 + r() * 2.4).toFixed(1)}" fill="#ffffff" opacity="${(0.15 + r() * 0.5).toFixed(2)}"/>`;
  }
  return {
    defs:
      '<linearGradient id="ab" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#1c1030"/></linearGradient>' +
      '<radialGradient id="acore" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient>' +
      '<filter id="ablur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="38"/></filter>',
    body:
      '<rect width="900" height="506" fill="url(#ab)"/>' +
      blobs +
      '<circle cx="450" cy="253" r="200" fill="url(#acore)" opacity="0.6"/>' +
      sparks +
      `<rect x="360" y="196" width="180" height="180" rx="34" fill="none" stroke="#a78bfa" stroke-width="2" opacity="0.75" transform="rotate(24 450 286)"/>` +
      `<rect x="390" y="226" width="120" height="120" rx="22" fill="none" stroke="#f0abfc" stroke-width="1.5" opacity="0.6" transform="rotate(-18 450 286)"/>`,
  };
}

const SCENES = [
  [/(sunset|dusk|golden|orange|dawn)/i, sceneSunset],
  [/(mountain|peak|alps|hills?|summit)/i, sceneMountains],
  [/(space|galaxy|star(s|ry|s)?|cosmos|nebula|planet|moon|astronaut)/i, sceneSpace],
  [/(wave|ocean|sea|water|beach|tide)/i, sceneWaves],
  [/(neon|cyber|synth|retro|vapor|grid|night\s+city)/i, sceneNeon],
  [/(abstract|geometric|minimal|art|logo|tech)/i, sceneAbstract],
];

function makeImageTool({ prompt, style, size, edit }, userId) {
  if (!prompt || typeof prompt !== 'string') throw new Error('A prompt string is required');
  const px = size === 1024 || size === '1024' ? 1024 : 512;
  const combined = `${style ? style + ', ' : ''}${prompt}`.slice(0, 1000);

  // Edit path: the user pointed at one of their own images (a /tools-output
  // URL). The engine edits that picture via img2img instead of creating a new
  // one, keeping the source's aspect ratio. Fall back to a fresh generation
  // only if the edit genuinely fails.
  if (edit && typeof edit === 'string' && edit.trim()) {
    return imagegen
      .editImage(userId, combined, edit.trim(), px)
      .then((r) => imageResult(true, r))
      .catch((err) => `Image edit failed: ${err.message} — if the user still wants the picture, generate it fresh instead.`);
  }

  // Primary path: real Stable Diffusion (512 or 1024 longest edge). Falls back
  // to an instant SVG scene only when the image engine is offline.
  return imagegen
    .generateImage(combined, undefined, userId, px)
    .then((r) => imageResult(false, r))
    .catch(async (err) => {
      const fallback = await makeSvgImage(prompt, style, userId);
      return `The Stable Diffusion engine is unavailable (${err.message}), so a quick SVG scene was generated instead: ${fallback} — tell the user the image is an SVG placeholder.`;
    });
}

function imageResult(edited, r) {
  const dims = r.width && r.height ? `${r.width}×${r.height}` : `${r.size}×${r.size}`;
  return `${edited ? 'Image edited' : 'Image generated'}: ${r.url} (${dims} PNG, ${edited ? `edited from ${r.editedFrom}` : 'Stable Diffusion'}) — show the user this URL so they can view or download the image.`;
}

function makeSvgImage(prompt, style, userId) {
  const seed = hashStr(prompt + '|' + (style || ''));
  const r = mulberry32(seed);
  const combined = `${style || ''} ${prompt}`;
  let scene = sceneAbstract(r);
  for (const [re, fn] of SCENES) {
    if (re.test(combined)) {
      scene = fn(r);
      break;
    }
  }
  const safe = `img-${seed.toString(16).padStart(8, '0')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 506" role="img" aria-label="${escXml(prompt)}">` +
    '<defs>' + scene.defs + '</defs>' +
    scene.body +
    '</svg>';
  const { dir, urlBase } = outPath(userId);
  const name = `${safe}.svg`;
  fs.writeFileSync(path.join(dir, name), svg);
  registerImage(userId, name, prompt, seed, 'svg');
  return `${urlBase}/${name}`;
}

/* ---------------- make_chart (SVG bar / line / pie) ---------------- */

function makeChartTool({ type, title, labels, values }, userId) {
  if (!Array.isArray(labels) || !Array.isArray(values) || labels.length === 0) {
    throw new Error('labels and values arrays are required');
  }
  if (labels.length !== values.length || labels.length > 20) {
    throw new Error('labels and values must match in length (max 20 points)');
  }
  const nums = values.map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Non-numeric value: ${v}`);
    return n;
  });
  const kind = String(type || 'bar').toLowerCase() === 'pie' ? 'pie' : String(type || '').toLowerCase() === 'line' ? 'line' : 'bar';
  const seed = hashStr(JSON.stringify({ labels, values, title }));
  const r = mulberry32(seed);
  const palette = ['#88b0a8', '#7c3aed', '#ec4899', '#06b6d4', '#f59e0b', '#22c55e', '#f43f5e', '#3b82f6'];
  const safe = `chart-${seed.toString(16).padStart(8, '0')}`;
  const w = 900;
  const h = 506;
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  let svg;

  if (kind === 'pie') {
    const total = nums.reduce((a, b) => a + b, 0);
    if (total <= 0) throw new Error('Pie chart values must sum to a positive number');
    const cx = 300;
    const cy = 253;
    const rad = 150;
    let angle = -Math.PI / 2;
    const slices = [];
    const cols = nums.map((n, i) => palette[i % palette.length]);
    nums.forEach((n, i) => {
      const sweep = (n / total) * 2 * Math.PI;
      const x1 = cx + rad * Math.cos(angle);
      const y1 = cy + rad * Math.sin(angle);
      angle += sweep;
      const x2 = cx + rad * Math.cos(angle);
      const y2 = cy + rad * Math.sin(angle);
      const large = sweep > Math.PI ? 1 : 0;
      slices.push(
        `<path d="M${cx} ${cy} L${x1.toFixed(1)} ${y1.toFixed(1)} A${rad} ${rad} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${cols[i]}" stroke="#0e1512" stroke-width="2"/>`,
      );
    });
    const legend = labels
      .map(
        (l, i) =>
          `<g transform="translate(500, ${150 + i * 34})"><rect x="0" y="-13" width="16" height="16" rx="3" fill="${cols[i]}"/><text x="24" y="0" font-size="15" fill="#e6f0ec">${esc(l)} — ${nums[i]}</text></g>`,
      )
      .join('');
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="Inter, sans-serif">` +
      `<rect width="${w}" height="${h}" rx="18" fill="#0e1512"/>` +
      `<text x="450" y="52" font-size="22" font-weight="600" fill="#e6f0ec" text-anchor="middle">${esc(title || 'Pie chart')}</text>` +
      slices.join('') +
      `<circle cx="${cx}" cy="${cy}" r="34" fill="#0e1512"/>` +
      legend +
      '</svg>';
  } else {
    const max = Math.max(...nums, 1);
    const padL = 54;
    const padB = 64;
    const padT = 64;
    const padR = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const step = plotW / Math.max(nums.length - 1, 1);
    const yAt = (v) => padT + plotH - (v / max) * plotH;
    let inner = '';

    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH / 4) * i;
      const gv = max - (max / 4) * i;
      inner += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${w - padR}" y2="${gy.toFixed(1)}" stroke="#26332f" stroke-width="1"/>` +
        `<text x="${padL - 10}" y="${(gy + 4).toFixed(1)}" font-size="13" fill="#8fa8a0" text-anchor="end">${gv < 1 ? gv.toFixed(2) : Math.round(gv)}</text>`;
    }
    if (kind === 'bar') {
      const bw = Math.max(10, Math.min(44, plotW / nums.length * 0.62));
      inner += nums
        .map((v, i) => {
          const x = padL + step * i - bw / 2;
          const y = yAt(v);
          const col = palette[i % palette.length];
          return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + plotH - y).toFixed(1)}" rx="5" fill="${col}" opacity="0.92">` +
            `<animate attributeName="opacity" values="0;0.92" dur="0.5s" fill="freeze"/></rect>` +
            `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" font-size="13" fill="#e6f0ec" text-anchor="middle">${v}</text>`;
        })
        .join('');
    } else {
      const pts = nums.map((v, i) => `${(padL + step * i).toFixed(1)},${yAt(v).toFixed(1)}`);
      inner += `<polygon points="${padL},${padT + plotH} ${pts.join(' ')} ${w - padR},${padT + plotH}" fill="#88b0a8" opacity="0.16"/>`;
      inner += `<polyline points="${pts.join(' ')}" fill="none" stroke="#88b0a8" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
      inner += nums
        .map((v, i) => {
          const [px, py] = pts[i].split(',');
          return `<circle cx="${px}" cy="${py}" r="5" fill="#0e1512" stroke="#88b0a8" stroke-width="2.5"/>` +
            `<text x="${px}" y="${(Number(py) - 12).toFixed(1)}" font-size="13" fill="#e6f0ec" text-anchor="middle">${v}</text>`;
        })
        .join('');
    }
    inner += labels
      .map(
        (l, i) =>
          `<text x="${(padL + step * i).toFixed(1)}" y="${h - padB + 24}" font-size="13" fill="#8fa8a0" text-anchor="middle">${esc(l)}</text>`,
      )
      .join('');
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="Inter, sans-serif">` +
      `<rect width="${w}" height="${h}" rx="18" fill="#0e1512"/>` +
      `<text x="${w / 2}" y="40" font-size="22" font-weight="600" fill="#e6f0ec" text-anchor="middle">${esc(title || (kind === 'line' ? 'Line chart' : 'Bar chart'))}</text>` +
      inner +
      '</svg>';
  }
  const { dir, urlBase } = outPath(userId);
  const name = `${safe}.svg`;
  fs.writeFileSync(path.join(dir, name), svg);
  registerImage(userId, name, title || `${kind} chart`, seed, 'chart');
  return `Chart generated: ${urlBase}/${name} (${kind} chart of ${labels.length} points) — give the user this URL.`;
}

/* ---------------- get_weather (Open-Meteo, no key) ---------------- */

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

async function getWeather({ city }) {
  if (!city || typeof city !== 'string') throw new Error('A city name is required');
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!geo.ok) throw new Error('geocoding failed');
  const json = await geo.json();
  const place = json.results && json.results[0];
  if (!place) return `Could not find a city matching "${city}".`;
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto',
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!w.ok) throw new Error('weather request failed');
  const data = await w.json();
  const c = data.current || {};
  const label = `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country ? ', ' + place.country : ''}`;
  return [
    `Weather in ${label} (now):`,
    `  Condition: ${WMO[c.weather_code] || c.weather_code}`,
    `  Temperature: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C)`,
    `  Humidity: ${c.relative_humidity_2m}%`,
    `  Wind: ${c.wind_speed_10m} km/h`,
    `  Daylight: ${c.is_day ? 'day' : 'night'}${data.current && data.time ? ` · update ${data.current.time}` : ''}`,
  ].join('\n');
}

/* ---------------- run_code ---------------- */

const WRAPPER = `
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const OUTPUT_DIR = process.argv[1];
const BASE_URL = '/tools-output/' + path.basename(OUTPUT_DIR);
const PDFDocument = createRequire(OUTPUT_DIR)('pdfkit');
const { renderMarkdownPdf } = createRequire(OUTPUT_DIR)(process.argv[3]);

const results = [];
const pendingPdfs = [];
function result(value) {
  results.push(String(value));
}
function makePdf(text, filename) {
  const safe = String(filename || 'output').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60);
  const file = path.join(OUTPUT_DIR, safe + '.pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const stream = fs.createWriteStream(file);
  const p = new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(BASE_URL + '/' + safe + '.pdf'));
    stream.on('error', reject);
    doc.pipe(stream);
    renderMarkdownPdf(doc, String(text));
    doc.end();
  });
  pendingPdfs.push(p);
  p.then((url) => results.push('PDF written: ' + url)).catch(() => {});
  return p;
}
const sandbox = {
  Math, Date, JSON, String, Number, Boolean, Array, Object,
  result, makePdf,
};
vm.createContext(sandbox);
let scriptError = null;
try {
  const script = new vm.Script(process.argv[2], { timeout: 25000 });
  script.runInContext(sandbox, { timeout: 25000 });
} catch (err) {
  scriptError = err;
}
Promise.allSettled(pendingPdfs).then(() => {
  if (scriptError) results.push('ERROR: ' + (scriptError && scriptError.message || String(scriptError)));
  process.stdout.write(JSON.stringify({ output: results.join('\\n').slice(0, 4000) }));
  process.exit(0);
});
`;

function runCode({ code }, userId) {
  return new Promise((resolve, reject) => {
    if (!code || typeof code !== 'string') return reject(new Error('A code string is required'));
    if (code.length > 8000) return reject(new Error('Code too long (max 8000 chars)'));

    const { dir } = outPath(userId);
    const child = execFile(
      process.execPath,
      ['-e', WRAPPER, dir, code, path.join(__dirname, 'md2pdf.js')],
      { timeout: 30000, maxBuffer: 8192 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) return reject(new Error('code timed out after 30s'));
          return reject(new Error(err.message.split('\n')[0]));
        }
        try {
          const { output } = JSON.parse(stdout);
          resolve(output || '(no output — call result(value) to return data)');
        } catch {
          resolve(stderr || '(sandbox produced no usable output)');
        }
      },
    );
    child.on('error', (e) => reject(e));
  });
}

/* ---------------- get_system_info ---------------- */

function getSystemInfo() {
  const cpus = os.cpus();
  const engine = (() => {
    try {
      const { getHealth } = require('../src/engine');
      const h = getHealth();
      return `ollama ${h.ollama} · turbofieldfare ${h.turbofieldfare} · imagegen ${h.imagegen || imagegen.getHealth().imagegen}`;
    } catch {
      return 'unknown';
    }
  })();
  const fmtBytes = (b) => {
    if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
    if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  };
  return [
    `Hostname: ${os.hostname()}`,
    `Platform: ${os.platform()} ${os.arch()} — ${os.release()}`,
    `CPU: ${cpus[0] ? cpus[0].model.trim() : 'unknown'} (${cpus.length} cores)`,
    `Memory: ${fmtBytes(os.totalmem())} total, ${fmtBytes(os.freemem())} free`,
    `Load: ${os.loadavg().map((l) => l.toFixed(2)).join(' / ')}`,
    `Uptime: ${Math.floor(os.uptime() / 60)} min`,
    `Node: ${process.version}`,
    `Engines: ${engine}`,
  ].join('\n');
}

/* ---------------- get_wikipedia (REST summary) ---------------- */

async function getWikipedia({ topic }) {
  if (!topic || typeof topic !== 'string') throw new Error('A topic string is required');
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.trim().replace(/ /g, '_'))}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    if (res.status === 404) return `No Wikipedia article found for "${topic}".`;
    throw new Error(`Wikipedia responded ${res.status}`);
  }
  const data = await res.json();
  return [
    `${data.title} — ${data.description || 'Wikipedia article'}`,
    '',
    (data.extract || 'No summary available.').slice(0, 1200),
    '',
    `Article: ${data.content_urls ? data.content_urls.desktop.page : `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`}`,
  ].join('\n');
}

/* ---------------- get_news (Google News RSS) ---------------- */

async function getNews({ query } = {}) {
  const q = String(query || '').trim();
  const feed = q
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  const res = await fetch(feed, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`news feed responded ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, 6);
  if (items.length === 0) return `No news found for "${q || 'top stories'}".`;
  return items
    .map((it, i) => {
      const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const date = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      return `${i + 1}. ${title.replace(/<!\[CDATA\[|\]\]>/g, '')}\n   ${link.trim()}\n   ${date.trim()}`;
    })
    .join('\n');
}

/* ---------------- fetch_url ---------------- */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a === 0
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' || lower.startsWith('::ffff:') ||
      lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
    );
  }
  return true;
}

/** Fetches a URL but never follows a redirect to a private/loopback address. */
async function fetchPublic(url, init, hops = 5) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const ip = net.isIP(host) ? host : (await lookup(host, { verbatim: true })).address;
  if (isPrivateIp(ip)) throw new Error('That URL points at a private/internal address, which is blocked');
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`redirect without location (${res.status})`);
    if (hops <= 0) throw new Error('too many redirects');
    return fetchPublic(new URL(loc, url).toString(), init, hops - 1);
  }
  return res;
}

async function fetchUrl({ url }) {
  if (!url || typeof url !== 'string') throw new Error('A URL string is required');
  const res = await fetchPublic(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 8000) + (text.length > 8000 ? '\n…(truncated)' : '');
}

/* ---------------- calculate (safe) ---------------- */

const EXPR_ALLOWED = /^[\d\s+\-*/().,%^a-zA-Z_.]+$/;

function calculate({ expression }) {
  if (!expression || typeof expression !== 'string') throw new Error('An expression string is required');
  if (expression.length > 200) throw new Error('Expression too long (max 200 chars)');
  if (!EXPR_ALLOWED.test(expression)) throw new Error('Expression contains disallowed characters');
  const math = Object.create(Math);
  const sandbox = { Math: math, pi: Math.PI, e: Math.E, ...math };
  ['abs', 'floor', 'ceil', 'round', 'pow', 'sqrt', 'min', 'max', 'log', 'exp', 'sin', 'cos', 'tan'].forEach(
    (f) => (sandbox[f] = Math[f].bind(Math)),
  );
  vm.createContext(sandbox);
  let value;
  try {
    value = vm.runInContext(`(function(){ return ${expression}; })()`, sandbox, { timeout: 5000 });
  } catch (err) {
    throw new Error('Could not evaluate: ' + err.message);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Expression must evaluate to a finite number');
  }
  return `${expression} = ${value}`;
}

/* ---------------- generate_password (cryptographic strength) ---------------- */

const crypto = require('node:crypto');

function generatePassword({ length }) {
  const len = Math.max(8, Math.min(64, Math.round(Number(length) || 16)));
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_=+?';
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [
    pick(upper), pick(lower), pick(digits), pick(symbols),
  ];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return `Generated password: ${chars.join('')} (${len} chars, includes upper/lower/digit/symbol)`;
}

/* ---------------- make_qr (SVG QR code) ---------------- */

function seedHash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function makeQrTool({ text, size }, userId) {
  if (!text || typeof text !== 'string' || !text.trim()) throw new Error('A text or URL to encode is required');
  const QRCode = require('qrcode');
  const px = Math.max(128, Math.min(1024, Number(size) || 512));
  const safe = safeBaseName('qr-' + String(text.replace(/\s+/g, '-')).slice(0, 36));
  const { dir, urlBase } = outPath(userId);
  const name = `${safe}.svg`;
  const svg = await QRCode.toString(text.trim(), {
    type: 'svg', width: px, margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0e1512', light: '#ffffff' },
  });
  fs.writeFileSync(path.join(dir, name), svg);
  registerImage(userId, name, 'QR code', seedHash(text), 'qr');
  return `QR code generated: ${urlBase}/${name} — encodes "${text.trim().slice(0, 80)}". Report this URL.`;
}

/* ---------------- convert_currency (ECB via frankfurter.app) ---------------- */

async function convertCurrency({ amount, from, to }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('A positive numeric amount is required');
  const f = String(from || 'USD').toUpperCase().trim();
  const t = String(to || 'EUR').toUpperCase().trim();
  const r = await fetch(
    `https://api.frankfurter.app/latest?amount=${amt}&from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!r.ok) throw new Error(`Currency lookup failed (${r.status}) — try codes like USD, EUR, GBP, JPY`);
  const j = await r.json();
  const converted = j.rates && j.rates[t];
  if (!converted) return `Unknown currency code "${t}".`;
  const rate = converted / amt;
  const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 });
  return `${amt.toLocaleString()} ${f} = ${fmt(converted)} ${t} (rate 1 ${f} = ${fmt(rate)} ${t}, ${j.date}).`;
}

/* ---------------- get_crypto (CoinGecko, no key) ---------------- */

async function getCrypto({ coin, currency }) {
  const id = String(coin || 'bitcoin').toLowerCase().trim();
  const cur = String(currency || 'usd').toLowerCase().trim();
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(cur)}&include_24hr_change=true`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!r.ok) throw new Error(`Price fetch failed (${r.status}) — CoinGecko may be rate-limited, retry shortly`);
  const j = await r.json();
  const d = j[id];
  if (!d) return `Unknown coin "${coin}" — try bitcoin, ethereum, solana, dogecoin.`;
  const chg = d[`${cur}_24h_change`];
  const chgTxt = typeof chg === 'number' ? ` (24h ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)` : '';
  const price = d[cur];
  const fmt = typeof price === 'number'
    ? price.toLocaleString(undefined, price < 1 ? { maximumFractionDigits: 6 } : { maximumFractionDigits: 2 })
    : String(price);
  return `${id} price: ${fmt} ${cur.toUpperCase()}${chgTxt}.`;
}

/* ---------------- get_astronomy (Open-Meteo, no key) ---------------- */

async function getAstronomy({ city }) {
  if (!city || typeof city !== 'string') throw new Error('A city name is required');
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!geo.ok) throw new Error('geocoding failed');
  const json = await geo.json();
  const place = json.results && json.results[0];
  if (!place) return `Could not find a city matching "${city}".`;
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&daily=sunrise,sunset,daylight_duration,moon_phase&timezone=auto&forecast_days=1',
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!w.ok) throw new Error('astronomy request failed');
  const data = await w.json();
  const d = (data.daily || {});
  const phase = Number(d.moon_phase?.[0] ?? 0);
  const MOON = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const moon = MOON[Math.round(phase * 8) % 8] || 'Unknown';
  const sunRise = (d.sunrise?.[0] || '—').slice(11);
  const sunSet = (d.sunset?.[0] || '—').slice(11);
  const dayMin = Math.round((Number(d.daylight_duration?.[0]) || 0) / 60);
  const label = `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country ? ', ' + place.country : ''}`;
  return `${label} — sunrise ${sunRise}, sunset ${sunSet}, daylight ${Math.floor(dayMin / 60)}h ${String(dayMin % 60).padStart(2, '0')}m, moon phase: ${moon}.`;
}

/* ---------------- define_word (free dictionary API) ---------------- */

async function defineWord({ word }) {
  const w = String(word || '').trim().toLowerCase();
  if (!w.trim()) throw new Error('A word is required');
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w.trim())}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 502) break;
    await new Promise((res) => setTimeout(res, 800));
  }
  if (r.status === 404) return `No dictionary entry found for "${w}".`;
  if (!r.ok) throw new Error(`Dictionary lookup failed (${r.status}) — try again in a moment`);
  const j = await r.json();
  const entry = j?.[0];
  if (!entry) return `No dictionary entry found for "${w}".`;
  const lines = [];
  for (const m of entry.meanings || []) {
    const d = m.definitions && m.definitions[0];
    if (!d) continue;
    lines.push(`${m.partOfSpeech}: ${d.definition}${d.example ? ` — “${d.example}”` : ''}`);
    if (lines.length >= 4) break;
  }
  const ph = entry.phonetic ? ` (${entry.phonetic})` : '';
  return `${w}${ph}\n${lines.join('\n') || 'No definitions found.'}`;
}

/* ---------------- make_diagram (SVG flow / sequence / mindmap) ---------------- */

const DIAGRAM_COLORS = ['#0f766e', '#8b5cf6', '#d97706', '#db2777', '#0ea5e9', '#65a30d'];

function makeDiagramTool({ type, title, steps }, userId) {
  const kind = String(type || 'flow').toLowerCase();
  const list = Array.isArray(steps) ? steps.map((s) => String(s)) : [];
  if (list.length < 1) throw new Error('Provide "steps" as an array of labels (at least 1)');
  const cap = list.map((s) => s.slice(0, 64)).slice(0, 8);
  const seed = seedHash(`${title || ''}|${kind}|${cap.join('|')}`) % DIAGRAM_COLORS.length;
  const W = 640;
  let inner = '';
  let frameH = 0;
  if (kind === 'sequence' || kind === 'timeline') {
    const cols = Math.min(cap.length, 3);
    const rows = Math.ceil(cap.length / cols);
    const colW = W / cols;
    const rowH = 128;
    frameH = 120 + rows * rowH;
    inner = cap
      .map((s, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = c * colW + 14;
        const y = 76 + r * rowH;
        const color = DIAGRAM_COLORS[(seed + i) % DIAGRAM_COLORS.length];
        let part =
          `<rect x="${x}" y="${y}" width="${colW - 28}" height="62" rx="12" fill="#161d29" stroke="${color}" stroke-width="2"/>` +
          `<text x="${x + (colW - 28) / 2}" y="${y + 28}" font-size="13" font-weight="600" fill="${color}" text-anchor="middle">Step ${i + 1}</text>` +
          `<text x="${x + (colW - 28) / 2}" y="${y + 46}" font-size="11.5" fill="#cfdfda" text-anchor="middle">${escXml(s).slice(0, 32)}</text>`;
        if (c < cols - 1) {
          part += `<path d="M ${x + colW - 30} ${y + 43} h 12 l -6 -7 M ${x + colW - 18} ${y + 43} l -6 7" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
        } else if (r < rows - 1) {
          part += `<path d="M ${x + (colW - 28) / 2} ${y + 86} v 12 l -6 -8 M ${x + (colW - 28) / 2} ${y + 98} l 6 -8" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        return part;
      })
      .join('');
  } else if (kind === 'mindmap') {
    frameH = Math.max(200, 96 + cap.length * 64);
    const hub = escXml(title || 'Idea').slice(0, 26);
    const hubColor = DIAGRAM_COLORS[seed % DIAGRAM_COLORS.length];
    inner = `<circle cx="92" cy="${frameH / 2}" r="54" fill="${hubColor}" opacity="0.18"/>` +
      `<circle cx="92" cy="${frameH / 2}" r="54" fill="none" stroke="${hubColor}" stroke-width="2.4"/>` +
      `<text x="92" y="${frameH / 2}" font-size="16" font-weight="700" fill="${hubColor}" text-anchor="middle">${hub}</text>`;
    cap.forEach((s, i) => {
      const col = i % 2;
      const rank = Math.floor(i / 2);
      const rowN = Math.ceil(cap.length / 2);
      const y = 70 + rank * (frameH - 140) / Math.max(rowN - 1, 1) + (frameH - 140) / (rowN * 2);
      const yc = Math.max(50, Math.min(frameH - 50, y));
      const x = 200 + col * 220;
      const color = DIAGRAM_COLORS[(seed + i) % DIAGRAM_COLORS.length];
      inner += `<path d="M 144 ${frameH / 2} C ${(144 + x) / 2} ${frameH / 2 + (col ? 10 : -10)}, ${(144 + x) / 2} ${yc}, ${x} ${yc}" fill="none" stroke="${color}" stroke-width="2"/>` +
        `<rect x="${x}" y="${yc - 26}" width="210" height="52" rx="12" fill="#161d22" stroke="${color}" stroke-width="2"/>` +
        `<text x="${x + 105}" y="${yc - 2}" font-size="13.5" font-weight="600" fill="${color}" text-anchor="middle">${escXml((i + 1) + '. ' + s).slice(0, 28)}</text>`;
    });
  } else {
    frameH = 70 + cap.length * 96;
    const cw = 380;
    const cx = W / 2;
    inner = cap
      .map((s, i) => {
        const y = 78 + i * 96;
        const color = DIAGRAM_COLORS[(seed + i) % DIAGRAM_COLORS.length];
        let part =
          `<rect x="${cx - cw / 2}" y="${y}" width="${cw}" height="58" rx="14" fill="#161d22" stroke="${color}" stroke-width="2"/>` +
          `<text x="${cx}" y="${y + 25}" font-size="15" font-weight="600" fill="${color}" text-anchor="middle">Step ${i + 1}</text>` +
          `<text x="${cx}" y="${y + 43}" font-size="12.5" fill="#cfdfda" text-anchor="middle">${escXml(s).slice(0, 46)}</text>`;
        if (i < cap.length - 1) {
          part += `<path d="M ${cx} ${y + 58} v 16 l -7 -8 M ${cx} ${y + 74} l 7 -8" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        return part;
      })
      .join('');
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${frameH}" font-family="Inter, sans-serif">` +
    `<rect width="${W}" height="${frameH}" rx="16" fill="#0e1512"/>` +
    (title ? `<text x="${W / 2}" y="44" font-size="22" font-weight="600" fill="#e6f0ec" text-anchor="middle">${escXml(title)}</text>` : '') +
    inner +
    '</svg>';
  const { dir, urlBase } = outPath(userId);
  const name = `${safeBaseName(title || kind)}-diagram.svg`;
  fs.writeFileSync(path.join(dir, name), svg);
  registerImage(userId, name, `diagram (${kind})`, seedHash(kind + title), 'diagram');
  return `Diagram generated: ${urlBase}/${name} (${kind} of ${cap.length} steps) — give the user this URL.`;
}

/* ---------------- check_uptime (HTTP probe) ---------------- */

async function checkUptime({ url, method }) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Provide a full URL starting with http(s)://');
  const m = String(method || 'HEAD').toUpperCase() === 'GET' ? 'GET' : 'HEAD';
  const t0 = Date.now();
  let res;
  try {
    res = await fetchPublic(target, {
      method: m,
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'DeepMT/1.0 uptime-check' },
    });
  } catch (err) {
    return `${target} is DOWN — could not reach it: ${err.message}`;
  }
  const ms = Date.now() - t0;
  const size = res.headers.get('content-length');
  const kb = size ? `, ${(Number(size) / 1024).toFixed(0)} KB` : '';
  return `${target} is UP — HTTP ${res.status} ${res.statusText}, ${m}, ${ms} ms${kb}.`;
}

/* ---------------- get_dns (Google DNS over HTTPS, no key) ---------------- */

async function getDns({ domain, type }) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error('Provide a valid domain, e.g. example.com');
  const t = String(type || 'A').toUpperCase();
  if (!['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'].includes(t)) throw new Error(`Unsupported type "${t}"`);
  const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=${t}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`DNS lookup failed (${r.status})`);
  const j = await r.json();
  if (j.Status !== 0 || !j.Answer) return `${t} records for ${d}: none found.`;
  const lines = j.Answer.map((a) => `  ${a.type} ${a.data}`).slice(0, 10);
  return `${t} records for ${d}:\n${lines.join('\n')}`;
}

/* ---------------- ocr_image (local vision model) ---------------- */

async function ocrImage({ image }, userId) {
  const vision = require('../src/vision');
  const file = path.basename(String(image || '').split('?')[0]);
  if (!file || !/\.(png|jpe?g|gif|webp)$/i.test(file)) {
    throw new Error('Provide an exact /tools-output image URL ending in .png/.jpg/.gif/.webp');
  }
  const dir = userDir(userId);
  if (!fs.existsSync(path.join(dir, file))) {
    throw new Error('Image not found — it must be one of the user\'s own /tools-output images');
  }
  const text = await vision.describeImage(userId, file, 'Transcribe ALL visible text exactly as written. Output only the text content, no commentary.');
  return `OCR result for ${file}:\n${text}`;
}

module.exports = { TOOLS, executeTool, extractToolCall, extractToolCalls, stripToolCalls, toolDescriptionBlock };