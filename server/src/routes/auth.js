const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, authRequired, newId } = require('../auth');

const router = express.Router();

function validUsername(username) {
  return (
    typeof username === 'string' &&
    /^[a-zA-Z0-9_\- ]{2,24}$/.test(username) &&
    username.trim().length >= 2
  );
}

function normalize(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email || null,
    username: user.username,
    created_at: user.created_at,
  };
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  const name = normalize(username).replace(/\s+/g, ' ');
  if (!validUsername(name)) {
    return res.status(400).json({ error: 'A username is required (2–24 letters, digits, spaces, _ or -)' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(name);
  if (exists) return res.status(409).json({ error: 'This username is already taken' });

  const id = newId();
  const email = `${name.replace(/[^a-zA-Z0-9]/g, '_')}@deepmt.local`;
  // Two spellings like "ab xyz" and "ab_xyz" derive the same email — check it
  // too, otherwise the UNIQUE constraint makes this request hang forever.
  const emailTaken = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
  if (emailTaken) {
    return res.status(409).json({ error: 'This username is too similar to an existing one — pick a different spelling' });
  }
  const passwordHash = await hashPassword(password);
  try {
    db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)')
      .run(id, name, email, passwordHash);
  } catch (err) {
    return res.status(409).json({ error: 'This username is already taken' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: publicUser(user), token: signToken(publicUser(user)) });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const idOrName = normalize(username);
  const user = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?')
    .get(idOrName, idOrName);
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.active_status !== 1) {
    return res.status(403).json({ error: 'This account is inactive' });
  }
  res.json({ user: publicUser(user), token: signToken(publicUser(user)) });
});

router.get('/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

module.exports = router;
