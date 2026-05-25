/**
 * stores.js - GET /api/v2/stores - session health per store + affiliate management
 */
'use strict';

const express = require('express');
const router  = express.Router();

module.exports = function(sessionManager, orchestrator) {

  // GET /api/v2/stores — session health per store
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

  // POST /api/v2/stores/enable — Enable a store's auto-publishing
  router.post('/enable', (req, res) => {
    const { store } = req.body || {};
    if (!['hotmart','cakto','amazon'].includes(store)) {
      return res.status(400).json({ error: 'Invalid store. Use: hotmart, cakto, amazon' });
    }
    const envKey = `AUTO_PUBLISH_${store.toUpperCase()}`;
    process.env[envKey] = 'true';
    res.json({ ok: true, message: `${store} auto-publish enabled (env: ${envKey}=true). Note: container restart needed to persist this setting.` });
  });

  // POST /api/v2/stores/affiliate/setup — Configure affiliates for all products (store: hotmart|cakto|all)
  router.post('/affiliate/setup', (req, res) => {
    const commission  = parseInt(req.body?.commission  ?? 50);
    const autoApprove = req.body?.autoApprove !== false;
    const limit       = parseInt(req.body?.limit ?? 999);
    const store       = (req.body?.store || 'all').toLowerCase();

    if (commission < 10 || commission > 80) {
      return res.status(400).json({ error: 'Commission must be between 10% and 80%' });
    }
    if (!['hotmart','cakto','all'].includes(store)) {
      return res.status(400).json({ error: 'store must be hotmart, cakto, or all' });
    }

    // Respond immediately — the job runs in background
    res.json({ ok: true, message: `Affiliate setup started for ${store}: ${commission}% commission, ${autoApprove ? 'auto' : 'manual'} approval. Running in background...` });

    setImmediate(async () => {
      if (store === 'hotmart' || store === 'all') {
        try {
          const { setupAllAffiliates: hmSetup } = require('../../../agents/publisherHotmartAffiliate');
          const r = await hmSetup({ commission, autoApprove, limit });
          console.info('[affiliate/hotmart] Complete:', JSON.stringify({ done: r.done, failed: r.failed }));
        } catch (e) {
          console.error('[affiliate/hotmart] Error:', e.message);
        }
      }
      if (store === 'cakto' || store === 'all') {
        try {
          const { setupAllAffiliates: caktoSetup } = require('../../../agents/publisherCaktoAffiliate');
          const r = await caktoSetup({ commission, autoApprove, limit });
          console.info('[affiliate/cakto] Complete:', JSON.stringify({ done: r.done, skipped: r.skipped, failed: r.failed }));
        } catch (e) {
          console.error('[affiliate/cakto] Error:', e.message);
        }
      }
    });
  });

  // POST /api/v2/stores/affiliate/single — Configure affiliate for one product
  router.post('/affiliate/single', (req, res) => {
    const { hotmartProductId, caktoProductId, commission = 50, autoApprove = true } = req.body || {};
    if (!hotmartProductId && !caktoProductId) {
      return res.status(400).json({ error: 'hotmartProductId or caktoProductId required' });
    }

    res.json({ ok: true, message: `Setting up affiliate for product...` });

    setImmediate(async () => {
      if (hotmartProductId) {
        try {
          const { setupSingleAffiliate: hmSingle } = require('../../../agents/publisherHotmartAffiliate');
          await hmSingle(hotmartProductId, { commission, autoApprove });
        } catch (e) {
          console.error('[affiliate/hotmart/single] Error:', e.message);
        }
      }
      if (caktoProductId) {
        try {
          const { setupSingleAffiliate: caktoSingle } = require('../../../agents/publisherCaktoAffiliate');
          await caktoSingle(caktoProductId, { commission, autoApprove });
        } catch (e) {
          console.error('[affiliate/cakto/single] Error:', e.message);
        }
      }
    });
  });

  return router;
};
