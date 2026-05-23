/**
 * stats.js - GET /api/stats (v2)
 */
'use strict';

const express = require('express');
const router  = express.Router();

module.exports = function(repo) {

  router.get('/', async (req, res) => {
    try {
      const stats = await repo.getStats();
      res.json({ ok: true, ...stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
