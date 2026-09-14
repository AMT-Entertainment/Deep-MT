/**
 * GET /api/tokens — overall and per-account token counters.
 *   {
 *     global: { all: {...}, today: {...} },
 *     user:   { all: {...}, today: {...}, perModel: [...] }
 *   }
 */
const express = require('express');
const { authRequired } = require('../auth');
const { globalSummary, userSummary } = require('../tokens');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  res.json({ global: globalSummary(), user: userSummary(req.user.id) });
});

module.exports = router;