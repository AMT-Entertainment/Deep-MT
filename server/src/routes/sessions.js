const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { authRequired, newId } = require('../auth');
const { userDir } = require('../files');
const logEvent = require('../events').logEvent;

const router = express.Router();
router.use(authRequired);

function sessionBelongsTo(req, res, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q) {
    // Search by session title OR by message content (user's own sessions only).
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    const sessions = db
      .prepare(
        `SELECT DISTINCT s.id, s.title, s.created_at, s.pinned
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.user_id = ?
           AND (s.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
         ORDER BY s.pinned DESC, s.created_at DESC LIMIT 30`,
      )
      .all(req.user.id, like, like);
    return res.json({ sessions });
  }
  const sessions = db
    .prepare('SELECT id, title, created_at, pinned FROM sessions WHERE user_id = ? ORDER BY pinned DESC, created_at DESC')
    .all(req.user.id);
  res.json({ sessions });
});

router.post('/', (req, res) => {
  const id = newId();
  const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 80)
    : 'New conversation';
  db.prepare('INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)').run(id, req.user.id, title);
  logEvent('chat', { message: 'conversation created', user: req.user.email.split('@')[0], title: title.slice(0, 60) });
  res.status(201).json({ session: { id, title, created_at: Date.now() } });
});

router.get('/:id/messages', (req, res) => {
  if (!sessionBelongsTo(req, res, req.params.id)) return;
  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json({ messages });
});

router.patch('/:id', (req, res) => {
  const session = sessionBelongsTo(req, res, req.params.id);
  if (!session) return;
  const body = req.body || {};
  const fields = [];
  const args = [];
  if (typeof body.title === 'string' && body.title.trim()) {
    fields.push('title = ?');
    args.push(body.title.trim().slice(0, 80));
  }
  if (typeof body.pinned === 'boolean') {
    fields.push('pinned = ?');
    args.push(body.pinned ? 1 : 0);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  args.push(session.id);
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  if (typeof body.pinned === 'boolean') {
    logEvent('chat', { message: `conversation ${body.pinned ? 'pinned' : 'unpinned'}`, user: req.user.email.split('@')[0] });
  }
  res.json({ session: updated });
});

/** Rewind a user turn: replaces its text and drops everything that came after
 * it, so the conversation can be re-asked from that point. */
router.patch('/:id/messages/:mid', (req, res) => {
  const session = sessionBelongsTo(req, res, req.params.id);
  if (!session) return;
  const msg = db
    .prepare('SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = ?')
    .get(req.params.mid, session.id, 'user');
  if (!msg) return res.status(404).json({ error: 'User message not found' });
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'A message is required' });
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, msg.id);
  db.prepare('DELETE FROM messages WHERE session_id = ? AND created_at > ?').run(session.id, msg.created_at);
  const messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(session.id);
  logEvent('chat', { message: 'conversation rewound + message edited', user: req.user.email.split('@')[0] });
  res.json({ messages });
});

router.delete('/:id', (req, res) => {
  const session = sessionBelongsTo(req, res, req.params.id);
  if (!session) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  res.status(204).end();
});

/** Exports a conversation as a Markdown file or a styled PDF into the user's
 * own folder. Returns the /tools-output URL of the saved export. */
router.post('/:id/export', async (req, res) => {
  const session = sessionBelongsTo(req, res, req.params.id);
  if (!session) return;
  const format = String((req.body && req.body.format) || 'md').toLowerCase();
  if (format !== 'md' && format !== 'pdf') return res.status(400).json({ error: 'format must be "md" or "pdf"' });

  const rows = db
    .prepare('SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(session.id);
  const md = rows
    .map((m) => (m.role === 'user' ? `## You\n\n${m.content || ''}` : `## DeepMT\n\n${m.content || ''}`))
    .join('\n\n---\n\n');
  const title = session.title || 'Conversation';
  const full = `# ${title}\n\n_Exported from DeepMT ${new Date().toISOString().slice(0, 16).replace('T', ' ')}_\n\n${md}`;

  const dir = userDir(req.user.id);
  const safe = String(title).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60) || 'conversation';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
  const urlBase = `/tools-output/${path.basename(dir)}`;

  if (format === 'pdf') {
    const PDFDocument = require('pdfkit');
    const { renderMarkdownPdf } = require('../../tools/md2pdf');
    const file = `${safe}-${stamp}.pdf`;
    try {
      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        const stream = fs.createWriteStream(path.join(dir, file));
        stream.on('finish', resolve);
        stream.on('error', reject);
        doc.pipe(stream);
        renderMarkdownPdf(doc, full);
        doc.end();
      });
    } catch (err) {
      return res.status(500).json({ error: 'PDF export failed: ' + err.message });
    }
    return res.json({ url: `${urlBase}/${file}`, format: 'pdf', name: file });
  }

  const file = `${safe}-${stamp}.md`;
  fs.writeFileSync(path.join(dir, file), full);
  res.json({ url: `${urlBase}/${file}`, format: 'md', name: file });
});

module.exports = router;
