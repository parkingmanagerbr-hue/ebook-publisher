/**
 * ebooks.js - GET /api/ebooks, GET /api/ebooks/:id routes (v2)
 */
'use strict';

const express = require('express');
const path    = require('path');
const router  = express.Router();

module.exports = function(repo, scorer) {

  // GET /api/ebooks
  router.get('/', async (req, res) => {
    try {
      const ebooks  = await repo.findAll(req.query.status || null);
      const scored  = scorer.scoreAll(ebooks);
      const payload = scored.map(({ ebook, score }) => ({
        ...ebook.toJSON(),
        mlScore:  score,
        category: scorer.getCategory(ebook),
        coverUrl: ebook.coverPath ? '/covers/' + path.basename(ebook.coverPath) : null,
        pdfUrl:   ebook.pdfPath   ? '/pdfs/'   + path.basename(ebook.pdfPath)   : null,
      }));
      res.json({ ok: true, ebooks: payload, total: payload.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/ebooks/:id
  router.get('/:id', async (req, res) => {
    try {
      const ebook = await repo.findById(req.params.id);
      if (!ebook) return res.status(404).json({ error: 'Ebook not found' });
      res.json({ ok: true, ebook: { ...ebook.toJSON(), mlScore: scorer.score(ebook) } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
