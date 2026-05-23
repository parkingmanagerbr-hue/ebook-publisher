/**
 * DashboardSocket.js - Socket.io server for real-time dashboard updates.
 *
 * SERVER EMITS:
 *  'stats'         -> { total, hotmart, cakto, amazon, pending, revenue }
 *  'queue'         -> { hotmart: [{id,title,status,progress}], cakto: [...], amazon: [...] }
 *  'log'           -> { level, store, message, ts }
 *  'store_status'  -> { hotmart:{active,queueSize,published}, cakto:{...}, amazon:{...} }
 *  'ebook_updated' -> { id, store, productId, url, ts }
 *
 * CLIENT EMITS:
 *  'publish_ebook' -> { ebookId, stores }
 *  'publish_batch' -> { stores, limit }
 *  'cancel_queue'  -> { store }
 */
'use strict';

const STATS_INTERVAL_MS = 5000;

class DashboardSocket {
  constructor(io, orchestrator, repo) {
    this.io           = io;
    this.orchestrator = orchestrator;
    this.repo         = repo;
    this._statsTimer  = null;
  }

  init() {
    this.io.on('connection', (socket) => {
      this._onConnect(socket);
    });

    // Wire orchestrator events to all connected clients
    this.orchestrator.on('log', (data) => {
      this.io.emit('log', data);
    });

    this.orchestrator.on('queue', (data) => {
      this.io.emit('queue', this._formatQueue(data));
    });

    this.orchestrator.on('ebook_updated', (data) => {
      this.io.emit('ebook_updated', data);
      this._emitStats();
    });

    // Periodic stats broadcast
    this._statsTimer = setInterval(() => this._emitStats(), STATS_INTERVAL_MS);

    return this;
  }

  _onConnect(socket) {
    // Send initial state
    this._emitStats();
    socket.emit('queue', this._formatQueue(this.orchestrator.getQueueStatus()));

    // Handle client commands
    socket.on('publish_ebook', async ({ ebookId, stores = ['hotmart', 'cakto'] }) => {
      try {
        this.io.emit('log', {
          level: 'info', store: 'system',
          message: 'Manual publish triggered for ebook ' + ebookId,
          ts: new Date().toISOString(),
        });
        await this.orchestrator.publishSingle(ebookId, stores);
      } catch (e) {
        socket.emit('log', { level: 'error', store: 'system', message: e.message, ts: new Date().toISOString() });
      }
    });

    socket.on('publish_batch', async ({ stores = ['hotmart', 'cakto'], limit = 50 }) => {
      try {
        this.io.emit('log', {
          level: 'info', store: 'system',
          message: 'Batch publish triggered for stores: ' + stores.join(', '),
          ts: new Date().toISOString(),
        });
        const result = await this.orchestrator.publishBatch(stores, limit);
        socket.emit('log', {
          level: 'info', store: 'system',
          message: 'Batch queued: ' + result.queued + ' ebooks, skipped: ' + result.skipped,
          ts: new Date().toISOString(),
        });
      } catch (e) {
        socket.emit('log', { level: 'error', store: 'system', message: e.message, ts: new Date().toISOString() });
      }
    });

    socket.on('cancel_queue', ({ store }) => {
      this.orchestrator.cancelQueue(store || null);
    });
  }

  _formatQueue(status) {
    const result = {};
    for (const [store, data] of Object.entries(status)) {
      result[store] = [
        ...(data.active  || []).map(j => ({ ...j, status: 'active'  })),
        ...(data.waiting || []).map(j => ({ ...j, status: 'waiting' })),
      ];
    }
    return result;
  }

  async _emitStats() {
    try {
      const stats = await this.repo.getStats();
      this.io.emit('stats', stats);
      this.io.emit('store_status', {
        hotmart: { active: this.orchestrator._processing.hotmart, queueSize: this.orchestrator.getQueueStatus().hotmart?.size || 0 },
        cakto:   { active: this.orchestrator._processing.cakto,   queueSize: this.orchestrator.getQueueStatus().cakto?.size   || 0 },
        amazon:  { active: this.orchestrator._processing.amazon,  queueSize: this.orchestrator.getQueueStatus().amazon?.size  || 0 },
      });
    } catch {}
  }

  stop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
  }
}

module.exports = { DashboardSocket };
