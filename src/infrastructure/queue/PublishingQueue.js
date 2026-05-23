/**
 * PublishingQueue.js — In-memory publishing queue with BullMQ-like interface.
 * Falls back to in-memory array if Redis/BullMQ unavailable.
 * Sequential processing per store (Puppeteer can't run in parallel safely).
 */
'use strict';

const EventEmitter = require('events');

class InMemoryQueue extends EventEmitter {
  constructor(name) {
    super();
    this.name    = name;
    this.items   = [];
    this.running = false;
  }

  async add(jobId, data) {
    // Deduplicate by ebookId
    if (this.items.find(i => i.data.ebookId === data.ebookId)) return null;
    const job = { id: jobId, data, status: 'waiting', progress: 0, addedAt: Date.now() };
    this.items.push(job);
    this.emit('added', job);
    return job;
  }

  /** Get all jobs (snapshot) */
  getJobs() {
    return [...this.items];
  }

  /** Get waiting + active jobs only */
  getPendingJobs() {
    return this.items.filter(i => ['waiting', 'active'].includes(i.status));
  }

  /** Mark job active */
  markActive(jobId) {
    const j = this.items.find(i => i.id === jobId);
    if (j) { j.status = 'active'; j.startedAt = Date.now(); }
  }

  /** Update progress 0-100 */
  updateProgress(jobId, progress) {
    const j = this.items.find(i => i.id === jobId);
    if (j) { j.progress = progress; this.emit('progress', j); }
  }

  /** Mark job completed and remove from active queue */
  markCompleted(jobId, result) {
    const j = this.items.find(i => i.id === jobId);
    if (j) {
      j.status = 'completed'; j.result = result; j.completedAt = Date.now();
      this.emit('completed', j);
      // Keep last 20 completed for dashboard history
      const completed = this.items.filter(i => i.status === 'completed');
      if (completed.length > 20) {
        const oldest = completed[0];
        this.items = this.items.filter(i => i.id !== oldest.id);
      }
    }
  }

  /** Mark job failed */
  markFailed(jobId, error) {
    const j = this.items.find(i => i.id === jobId);
    if (j) {
      j.status = 'failed'; j.error = error.message || String(error);
      j.attempts = (j.attempts || 0) + 1;
      this.emit('failed', j, error);
      // Re-queue if under retry limit
      if (j.attempts < 2) {
        j.status = 'waiting';
        j.startedAt = null;
      }
    }
  }

  /** Clear all jobs for a store */
  clear() {
    this.items = [];
    this.emit('cleared');
  }

  get size() {
    return this.getPendingJobs().length;
  }
}

class PublishingQueue {
  constructor() {
    this.queues = {
      hotmart: new InMemoryQueue('hotmart-q'),
      cakto:   new InMemoryQueue('cakto-q'),
      amazon:  new InMemoryQueue('amazon-q'),
    };
  }

  /**
   * Add an ebook to the queue for a platform.
   * @param {string} platform
   * @param {string} ebookId
   * @param {Object} data
   */
  async enqueue(platform, ebookId, data) {
    const q = this.queues[platform];
    if (!q) throw new Error(`Unknown platform: ${platform}`);
    return q.add(`${platform}-${ebookId}`, { ebookId, ...data });
  }

  /** @param {string} platform @returns {InMemoryQueue} */
  getQueue(platform) {
    return this.queues[platform];
  }

  /** Summary for all platforms */
  getStatus() {
    const result = {};
    for (const [name, q] of Object.entries(this.queues)) {
      const jobs = q.getJobs();
      result[name] = {
        size:      q.size,
        active:    jobs.filter(j => j.status === 'active').map(j => ({
          id: j.data.ebookId, title: j.data.title, status: j.status, progress: j.progress,
        })),
        waiting:   jobs.filter(j => j.status === 'waiting').map(j => ({
          id: j.data.ebookId, title: j.data.title, status: j.status, progress: 0,
        })),
        completed: jobs.filter(j => j.status === 'completed').length,
        failed:    jobs.filter(j => j.status === 'failed').length,
      };
    }
    return result;
  }

  /** Clear all queues or a specific platform queue */
  clearQueue(platform = null) {
    if (platform) {
      this.queues[platform]?.clear();
    } else {
      Object.values(this.queues).forEach(q => q.clear());
    }
  }

  on(platform, event, handler) {
    this.queues[platform]?.on(event, handler);
  }
}

// Singleton
const instance = new PublishingQueue();
module.exports = { PublishingQueue: instance, InMemoryQueue };
