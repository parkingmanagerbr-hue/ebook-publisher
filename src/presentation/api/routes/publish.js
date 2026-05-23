/**
 * publish.js - POST /api/publish/single, /batch, /cancel; GET /api/publish/status
 */
'use strict';

const express = require('express');
const router  = express.Router();

module.exports = function(orchestrator) {

  router.post('/single', async (req, res) => {
    try {
      const { ebookId, stores = ['hotmart', 'cakto'] } = req.body;
      if (!ebookId) return res.status(400).json({ error: 'ebookId required' });
      res.json({ ok: true, message: 'Publishing started', ebookId });
      orchestrator.publishSingle(ebookId, stores).catch(e => console.error('publishSingle:', e.message));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/batch', async (req, res) => {
    try {
      const { stores = ['hotmart', 'cakto'], limit = 50 } = req.body;
      const result = await orchestrator.publishBatch(stores, limit);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/status', (req, res) => {
    try {
      res.json({ ok: true, ...orchestrator.getStatus() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/cancel', (req, res) => {
    try {
      const { store } = req.body;
      orchestrator.cancelQueue(store || null);
      res.json({ ok: true, message: 'Queue cancelled for ' + (store || 'all stores') });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
