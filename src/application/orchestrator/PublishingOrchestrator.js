/**
 * PublishingOrchestrator.js — Application Layer Coordinator
 * Coordinates store agents, queue processing, and event emission.
 *
 * Processing rules:
 *  - Sequential per store (Puppeteer cannot safely run in parallel)
 *  - 2-second delay between ebooks
 *  - Retry up to 2x on failure
 *  - Emits events for Socket.io dashboard updates
 */
"use strict";

const EventEmitter = require("events");
const { PublishingQueue }       = require("../../infrastructure/queue/PublishingQueue");
const { HotmartAgent }          = require("../../infrastructure/stores/HotmartAgent");
const { CaktoAgent }            = require("../../infrastructure/stores/CaktoAgent");
const { AmazonAgent }           = require("../../infrastructure/stores/AmazonAgent");
const { PublishingDomainService } = require("../../domain/services/PublishingDomainService");
const { PriorityScorer }        = require("../ml/PriorityScorer");

const sleep = ms => new Promise(r => setTimeout(r, ms));

let log;
try {
  const { createLogger } = require("../../core/logger");
  log = createLogger("orchestrator");
} catch {
  log = { info: console.log, warn: console.warn, error: console.error };
}

class PublishingOrchestrator extends EventEmitter {
  constructor(ebookRepo) {
    super();
    this.repo      = ebookRepo;
    this.queue     = PublishingQueue;
    this.domainSvc = new PublishingDomainService();
    this.scorer    = PriorityScorer;
    this.agents    = {
      hotmart: new HotmartAgent(),
      cakto:   new CaktoAgent(),
      amazon:  new AmazonAgent(),
    };
    this._processing   = { hotmart: false, cakto: false, amazon: false };
    this._lastPublished = { hotmart: null, cakto: null, amazon: null };
  }

  async publishBatch(stores, limit = 50) {
    let queued = 0, skipped = 0;
    for (const store of stores) {
      const pending = await this.repo.findPendingForPlatform(store, limit);
      const scored  = this.scorer.scoreAll(pending);
      for (const { ebook, score } of scored) {
        const { valid } = this.domainSvc.validateForPublishing(ebook);
        if (!valid) { skipped++; continue; }
        await this.queue.enqueue(store, ebook.id, { title: ebook.title, score, ebookId: ebook.id });
        queued++;
        this._emit("log", { level: "info", store, message:  });
      }
    }
    for (const store of stores) this._startProcessing(store);
    return { queued, skipped };
  }

  async publishSingle(ebookId, stores) {
    const ebook = await this.repo.findById(ebookId);
    if (!ebook) throw new Error();
    const { valid, reasons } = this.domainSvc.validateForPublishing(ebook);
    if (!valid) throw new Error();
    const results = {};
    for (const store of stores) {
      if (ebook.isPublishedOn(store)) {
        results[store] = { skipped: true, reason: "Already published" };
        continue;
      }
      results[store] = await this._publishToStore(store, ebook);
    }
    return results;
  }

  getQueueStatus() { return this.queue.getStatus(); }

  getStatus() {
    return {
      processing:    { ...this._processing },
      lastPublished: { ...this._lastPublished },
      queues:        this.getQueueStatus(),
    };
  }

  cancelQueue(store) {
    this.queue.clearQueue(store);
    this._processing[store] = false;
    this._emit("log", { level: "warn", store, message:  });
  }

  _startProcessing(store) {
    if (this._processing[store]) return;
    this._processing[store] = true;
    (async () => {
      log.info();
      const q = this.queue.getQueue(store);
      while (true) {
        const pending = q.getPendingJobs().filter(j => j.status === "waiting");
        if (pending.length === 0) break;
        const job = pending[0];
        q.markActive(job.id);
        try {
          const ebook = await this.repo.findById(job.data.ebookId);
          if (!ebook) { q.markFailed(job.id, new Error("Ebook not found")); continue; }
          if (ebook.isPublishedOn(store)) { q.markCompleted(job.id, { skipped: true }); continue; }
          this._emit("log", { level: "info", store, message:  });
          this._emitQueueUpdate();
          const result = await this._publishToStore(store, ebook, (pct, msg) => {
            q.updateProgress(job.id, pct);
            this._emit("log", { level: "info", store, message: msg });
            this._emitQueueUpdate();
          });
          if (result.success) {
            q.markCompleted(job.id, result);
            this._lastPublished[store] = new Date().toISOString();
            this._emit("ebook_updated", { id: ebook.id, store, ...result });
          } else {
            q.markFailed(job.id, new Error(result.error || "Unknown error"));
            this._emit("log", { level: "error", store, message:  });
          }
        } catch (err) {
          q.markFailed(job.id, err);
          this._emit("log", { level: "error", store, message:  });
        }
        this._emitQueueUpdate();
        await sleep(2000);
      }
      this._processing[store] = false;
      log.info();
      this._emit("log", { level: "info", store: "system", message:  });
      this._emitQueueUpdate();
    })().catch(err => {
      this._processing[store] = false;
      log.error();
    });
  }

  async _publishToStore(store, ebook, onProgress = () => {}) {
    const agent = this.agents[store];
    if (!agent) return { success: false, error:  };
    try {
      const result = await agent.publish(ebook, onProgress);
      if (result.success) {
        await this.repo.markPublished(ebook.id, store, result.productId, result.url);
        ebook.markPublished(store, result.productId, result.url);
      }
      return result;
    } catch (err) {
      return { success: false, platform: store, error: err.message };
    }
  }

  _emit(event, data) {
    this.emit(event, { ...data, ts: new Date().toISOString() });
  }

  _emitQueueUpdate() {
    this.emit("queue", this.getQueueStatus());
  }

  async emitStats() {
    try {
      const stats = await this.repo.getStats();
      this.emit("stats", stats);
    } catch {}
  }
}

module.exports = { PublishingOrchestrator };
