/**
 * gutenberg.js — GET/POST /api/v2/gutenberg
 * Catálogo de audiobooks de livros famosos (Project Gutenberg / domínio público)
 */
'use strict';

const express = require('express');
const router  = express.Router();

module.exports = function() {
  const { listCatalog, generateSingleBook, generateAllFamousAudiobooks, FAMOUS_BOOKS } = require('../../../agents/gutenbergAgent');

  // GET /api/v2/gutenberg — listar catálogo com status
  router.get('/', (req, res) => {
    try {
      const catalog = listCatalog();
      const done    = catalog.filter(b => b.status === 'done').length;
      const pending = catalog.filter(b => b.status === 'pending').length;
      const failed  = catalog.filter(b => b.status === 'failed').length;
      res.json({ ok: true, total: catalog.length, done, pending, failed, books: catalog });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v2/gutenberg/generate — gerar todos os pendentes (background)
  router.post('/generate', (req, res) => {
    res.json({ ok: true, message: 'Geração iniciada em background', total: FAMOUS_BOOKS.length });
    // Rodar em background sem await
    generateAllFamousAudiobooks().catch(err =>
      console.error('[gutenberg] generateAll error:', err.message)
    );
  });

  // POST /api/v2/gutenberg/generate/:id — gerar livro específico
  router.post('/generate/:id', (req, res) => {
    const { id } = req.params;
    const book = FAMOUS_BOOKS.find(b => b.id === id);
    if (!book) return res.status(404).json({ error: `Livro não encontrado: ${id}` });

    res.json({ ok: true, message: `Gerando audiobook: ${book.title}`, id });
    generateSingleBook(id).catch(err =>
      console.error(`[gutenberg] generate ${id} error:`, err.message)
    );
  });

  return router;
};
