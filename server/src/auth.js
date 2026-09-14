const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-deepmt-local-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const BCRYPT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  // Bearer header is the primary channel; `?token=` is accepted as a fallback
  // so <img>/<a download> tags — which cannot set headers — can fetch a user's
  // own generated files from the authenticated /tools-output route.
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : typeof req.query?.token === 'string'
      ? req.query.token
      : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { hashPassword, verifyPassword, signToken, authRequired, newId: randomUUID };
