/**
 * API key management — /api/keys.
 *   POST   /api/keys           create a key (plaintext returned once)
 *   GET    /api/keys           list your keys (no secrets)
 *   DELETE /api/keys/:id       revoke a key
 */
const express = require('express');
const { authRequired } = require('../auth');
const { createKey, listKeys, revokeKey } = require('../apikeys');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  res.json({ keys: listKeys(req.user.id) });
});

router.post('/', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60) || 'Untitled';
  const created = createKey(req.user.id, name);
  res.status(201).json(created);
});

router.delete('/:id', (req, res) => {
  if (revokeKey(req.user.id, req.params.id)) return res.json({ ok: true });
  res.status(404).json({ error: 'Key not found' });
});

module.exports = router;