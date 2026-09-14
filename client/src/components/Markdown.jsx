import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getApiBase } from '../api';

marked.setOptions({ gfm: true, breaks: true });

const IMG_RE = /\/tools-output\/.+\.(svg|png|jpe?g|gif|webp)(\?.*)?$/i;
const FILE_RE = /\/tools-output\/.+\.(pdf|md|txt|csv|html)(\?.*)?$/i;

marked.use({
  renderer: {
    code({ text, lang }) {
      const safeLang = DOMPurify.sanitize(String(lang || ''))
        .replace(/[^a-zA-Z0-9+#-]/g, '')
        .slice(0, 20);
      const attr = safeLang ? ` data-lang="${safeLang}"` : '';
      return `<pre${attr}><code>${text}</code></pre>`;
    },
    link({ href, title, tokens }) {
      const url = String(href || '').trim();
      const safeUrl = DOMPurify.sanitize(url);
      const text = tokens.map((t) => t.raw).join('').trim();
      const safeText = DOMPurify.sanitize(text).slice(0, 160);

      if (IMG_RE.test(url)) {
        const src = safeUrl.replace(/\s+/g, '%20');
        const isRaster = /\.(png|jpe?g|gif|webp)$/i.test(src);
        return (
          `<figure class="md-media">` +
          `<div class="md-media__frame">` +
          `<img class="md-media__img" src="${src}" alt="${safeText || 'generated image'}" loading="lazy" />` +
          `<div class="md-media__overlay">` +
          (isRaster
            ? `<button type="button" class="md-media__action" data-md-edit="${src}" title="Edit with AI" aria-label="Edit this image with AI"><span class="material-symbols-outlined">edit</span></button>` +
              `<button type="button" class="md-media__action" data-md-vary="${src}" title="Create a variation" aria-label="Create a variation of this image"><span class="material-symbols-outlined">autorenew</span></button>`
            : '') +
          `<a class="md-media__action" href="${src}" download title="Download full resolution" aria-label="Download full resolution"><span class="material-symbols-outlined">download</span></a>` +
          `</div>` +
          `</div>` +
          `<figcaption class="md-media__cap">${safeText || 'Generated image'}</figcaption>` +
          `</figure>`
        );
      }
      if (FILE_RE.test(url)) {
        return `<a class="file-chip" href="${safeUrl}" download>⤓ ${safeText || 'Download file'}</a>`;
      }
      const t = title ? ` title="${DOMPurify.sanitize(title)}"` : '';
      return `<a href="${safeUrl}"${t}>${text}</a>`;
    },
  },
});

export default function Markdown({ text }) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('deepmt_token') || '' : '';
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(marked.parse(text || ''));
    const base = getApiBase();
    // Auth-protected tool output needs the JWT on every local URL (<img>, <a>)
    // since browser requests for these elements can't send the Authorization
    // header — append it as a query param that authRequired accepts.
    // In GitHub Pages mode (remote backend) also absolutize to the tunnel URL.
    const withBase = base
      ? sanitized.replace(/(src|href)="(\/tools-output\/[^"]*)"/g, (_m, attr, p) => `${attr}="${base}${p}"`)
      : sanitized;
    if (!token) return withBase;
    return withBase.replace(/(src|href)="((?:https?:\/\/[^"]+)?\/tools-output\/[^"?]*)(\?[^"]*)?"/g, (_m, attr, p, q) => {
      if (q && q.includes('token=')) return `${attr}="${p}${q}"`;
      const sep = q ? '&' : '?';
      return `${attr}="${p}${q || ''}${sep}token=${encodeURIComponent(token)}"`;
    });
  }, [text, token]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
