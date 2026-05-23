/**
 * stores.js - GET /api/stores - session health per store
 */
'use strict';

const express = require('express');
const router  = express.Router();

module.exports = function(sessionManager, orchestrator) {

  router.get('/', (req, res) => {
    try {
      const sessions    = sessionManager.getAllStatus();
      const queueStatus = orchestrator.getQueueStatus();
      const last        = orchestrator._lastPublished;
      const result = {};
      for (const platform of ['hotmart', 'cakto', 'amazon']) {
        const s = sessions[platform] || {};
        const q = queueStatus[platform] || {};
        result[platform] = {
          session: {
            exists:    s.exists    || false,
            valid:     s.valid     || false,
            savedAt:   s.savedAt   || null,
            expiresIn: s.expiresIn || 0,
          },
          queue: {
            size:      q.size      || 0,
            active:    q.active    || [],
            completed: q.completed || 0,
            failed:    q.failed    || 0,
          },
          lastPublished: last[platform] || null,
          processing:    orchestrator._processing[platform] || false,
        };
      }
      res.json({ ok: true, stores: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
