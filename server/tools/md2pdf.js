/**
 * Markdown -> PDF renderer built on pdfkit.
 * Styles headings, bold/italic/inline-code, bullet & numbered lists,
 * fenced code blocks, blockquotes, and horizontal rules.
 * Pages flow naturally — paragraphs are NOT forced onto separate pages.
 */

const FONT = {
  normal: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  mono: 'Courier',
};

const INK = '#1c1c1c';
const MUTED = '#5f6b66';
const TEAL = '#0f766e';
const CODE_BG = '#f1f4f3';
const RULE = '#d8dfdc';

function parseInline(text) {
  const runs = [];
  const re = /(`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index), s: 'n' });
    const tok = m[0];
    if (tok.startsWith('`')) runs.push({ t: tok.slice(1, -1), s: 'c' });
    else if (tok.startsWith('***')) runs.push({ t: tok.slice(3, -3), s: 'bi' });
    else if (tok.startsWith('**')) runs.push({ t: tok.slice(2, -2), s: 'b' });
    else runs.push({ t: tok.slice(1, -1), s: 'i' });
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push({ t: text.slice(last), s: 'n' });
  return runs;
}

function stripInline(text) {
  return String(text).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

function makePage(doc) {
  doc.addPage();
  return doc.y - doc.page.margins.top;
}

function renderMarkdownPdf(doc, text) {
  const M = doc.page.margins.left;
  const W = doc.page.width - M * 2;
  const bottomRoom = doc.page.height - doc.page.margins.bottom;

  function ensureRoom(h) {
    if (doc.y + h > bottomRoom) doc.addPage();
  }

  function writeRuns(runs, { size = 11, color = INK, y = null, x = null, width = W, lineGap = 4 } = {}) {
    doc.save();
    doc.fontSize(size);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      doc.font(FONT[r.s === 'b' ? 'bold' : r.s === 'i' ? 'italic' : r.s === 'bi' ? 'boldItalic' : r.s === 'c' ? 'mono' : 'normal']);
      doc.fillColor(r.s === 'c' ? TEAL : color);
      if (x !== null && i === 0) doc.x = x;
      if (y !== null && i === 0) doc.y = y;
      doc.text(r.t, { continued: i < runs.length - 1, lineGap, width: x !== null ? width - (x - M) : width });
    }
    doc.restore();
    doc.fillColor(INK);
  }

  function heading(text, level) {
    const size = level === 1 ? 20 : level === 2 ? 16 : level === 3 ? 13.5 : 12;
    const space = level === 1 ? 10 : 8;
    ensureRoom(size * 1.9);
    doc.moveDown(space * 0.6);
    writeRuns(parseInline(text), { size, color: TEAL });
    doc.moveDown(space * 0.7);
  }

  function paragraph(text) {
    const runs = parseInline(text);
    ensureRoom(16);
    writeRuns(runs, { lineGap: 5 });
    doc.moveDown(0.6);
  }

  function list(items, numbered) {
    const marker = numbered ? (i) => `${i + 1}. ` : () => '• ';
    const markerW = numbered ? 26 : 16;
    const textW = W - markerW;
    items.forEach((item, i) => {
      ensureRoom(16);
      const y0 = doc.y;
      doc.fontSize(11).font(FONT.normal).fillColor(INK);
      doc.text(marker(i), M, y0, { width: markerW, lineGap: 5 });
      doc.fontSize(11);
      writeRuns(parseInline(item), { x: M + markerW, y: y0, width: textW, lineGap: 5 });
      doc.moveDown(0.35);
    });
    doc.moveDown(0.35);
  }

  function codeBlock(lines) {
    const code = lines.join('\n');
    const fs = 9;
    const pad = 10;
    const boxW = W;
    const innerW = boxW - pad * 2;
    const height = doc.heightOfString(code, { width: innerW, fontSize: fs, lineGap: 2 }) + pad * 2;
    ensureRoom(height + 8);
    const y0 = doc.y;
    doc.save();
    doc.rect(M, y0, boxW, height).fill(CODE_BG);
    doc.font(FONT.mono).fontSize(fs).fillColor(INK);
    doc.text(code, M + pad, y0 + pad, { width: innerW, lineGap: 2 });
    doc.restore();
    doc.moveDown(1.1);
  }

  function blockquote(text) {
    ensureRoom(20);
    const runs = parseInline(text);
    const width = W - 18;
    const height = doc.heightOfString(stripInline(text), { width, fontSize: 11 }) + 12;
    doc.save();
    doc.rect(M, doc.y, 3, height).fill(TEAL);
    doc.restore();
    writeRuns(runs, { x: M + 14, y: doc.y + 5, width, color: MUTED });
    doc.moveDown(0.9);
  }

  function hr() {
    ensureRoom(24);
    doc.moveDown(0.9);
    doc.save();
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1).strokeColor(RULE).stroke();
    doc.restore();
    doc.moveDown(1.4);
  }

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let inCode = false;
  let codeBuf = [];

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (inCode) {
      if (/^```/.test(line)) {
        codeBlock(codeBuf);
        inCode = false;
        codeBuf = [];
      } else {
        codeBuf.push(raw);
      }
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      inCode = true;
      codeBuf = [];
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      heading(h[2], h[1].length);
      i++;
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      hr();
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blockquote(buf.join(' '));
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      let numbered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length) {
        const l = lines[i].trim();
        const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (!item) {
          if (/^\s*$/.test(l)) { i++; break; }
          break;
        }
        items.push(item[1]);
        i++;
      }
      list(items, numbered);
      continue;
    }

    if (!line) {
      i++;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i].trim();
      if (
        !l ||
        /^(#{1,6})\s+/.test(l) ||
        /^>\s?/.test(l) ||
        /^\s*(?:[-*+]|\d+[.)])\s+/.test(l) ||
        /^\s*(?:---|\*\*\*|___)\s*$/.test(l) ||
        /^```/.test(l)
      ) {
        break;
      }
      buf.push(l);
      i++;
    }
    paragraph(buf.join(' '));
  }

  if (inCode) codeBlock(codeBuf);
}

module.exports = { renderMarkdownPdf };
