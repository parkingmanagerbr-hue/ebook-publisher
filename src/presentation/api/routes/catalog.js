/**
 * catalog.js - Public download catalog (no payment gate, temporary access).
 * Exposes a paginated read-only listing of ebooks ready for download and a
 * streaming download endpoint. Access control is enforced upstream at the
 * nginx layer (HTTP Basic Auth) — this router assumes the request already
 * passed that gate.
 */
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX     = 50;

module.exports = function (repo) {
  const router = express.Router();

  async function listDownloadable() {
    const all = await repo.findAll(null);
    return all
      .filter((e) => e.pdfPath && e.coverPath && fs.existsSync(e.pdfPath))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  router.get('/ebooks', async (req, res) => {
    try {
      const items    = await listDownloadable();
      const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.pageSize, 10) || PAGE_SIZE_DEFAULT));
      const total    = items.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page     = Math.min(totalPages, Math.max(1, parseInt(req.query.page, 10) || 1));
      const start    = (page - 1) * pageSize;

      const pageItems = items.slice(start, start + pageSize).map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description || e.subtitle || '',
        coverUrl: '/catalog/api/cover/' + e.id,
        downloadUrl: '/catalog/api/download/' + e.id,
      }));

      res.json({ ok: true, page, pageSize, total, totalPages, items: pageItems });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/cover/:id', async (req, res) => {
    try {
      const ebook = await repo.findById(req.params.id);
      if (!ebook || !ebook.coverPath || !fs.existsSync(ebook.coverPath)) {
        return res.status(404).end();
      }
      res.sendFile(path.resolve(ebook.coverPath));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/download/:id', async (req, res) => {
    try {
      const ebook = await repo.findById(req.params.id);
      if (!ebook || !ebook.pdfPath || !fs.existsSync(ebook.pdfPath)) {
        return res.status(404).json({ error: 'Ebook not found' });
      }
      const niceName = (ebook.title || 'ebook').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 80) + '.pdf';
      res.download(path.resolve(ebook.pdfPath), niceName);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
