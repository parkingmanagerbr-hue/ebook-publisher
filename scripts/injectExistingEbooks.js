'use strict';
/**
 * injectExistingEbooks.js — Injeta os 3 ebooks pre-existentes no banco para publicação
 * 
 * Ebooks:
 *   1. Financas Pessoais Descomplicadas
 *   2. Como Sair das Dividas de Forma Definitiva
 *   3. Healthy Weight Loss Without Hunger
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PDFS_DIR   = path.join(__dirname, '../data/pdfs');
const COVERS_DIR = path.join(__dirname, '../data/covers');
const TEMP       = 'C:/Users/m_rov/AppData/Local/Temp';

fs.mkdirSync(PDFS_DIR,   { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

const BOOKS = [
  {
    title:       'Financas Pessoais Descomplicadas',
    description: 'Guia completo e prático de finanças pessoais para organizar sua vida financeira, sair das dívidas e construir patrimônio com estratégias simples e eficazes.',
    topic:       'finanças pessoais',
    pdfSrc:      path.join(TEMP, 'financas_pessoais.pdf'),
    coverSrc:    path.join(TEMP, 'financas_pessoais_cover.png'),
    price:       29.90,
    language:    'pt-BR',
  },
  {
    title:       'Como Sair das Dividas de Forma Definitiva',
    description: 'Estratégias comprovadas para eliminar dívidas e recuperar o controle financeiro. Guia prático passo a passo.',
    topic:       'dívidas finanças',
    pdfSrc:      path.join(TEMP, 'dividas.pdf'),
    coverSrc:    path.join(TEMP, 'dividas_cover.png'),
    price:       29.90,
    language:    'pt-BR',
  },
  {
    title:       'Healthy Weight Loss Without Hunger',
    description: 'Complete practical guide to healthy and sustainable weight loss without hunger. Evidence-based strategies for nutrition, metabolism, and lifestyle changes.',
    topic:       'weight loss health diet',
    pdfSrc:      path.join(TEMP, 'healthy_weight.pdf'),
    coverSrc:    path.join(TEMP, 'healthy_weight_cover.png'),
    price:       29.90,
    language:    'en',
  },
];

async function inject() {
  const db = require('../src/core/database');
  const rawDb = db.getDb();

  console.log('=== Injetando ebooks pre-existentes no banco ===');

  for (const book of BOOKS) {
    // Check if already exists
    const existing = rawDb.prepare('SELECT id FROM ebooks WHERE title = ?').get(book.title);
    if (existing) {
      console.log(`⏭️  Já existe: "${book.title}" (id=${existing.id})`);
      continue;
    }

    // Copy files to data directories
    const ebookId  = uuidv4();
    const pdfDest  = path.join(PDFS_DIR,   `ebook_existing_${ebookId}.pdf`);
    const coverDest = path.join(COVERS_DIR, `cover_existing_${ebookId}.png`);

    if (!fs.existsSync(book.pdfSrc)) {
      console.log(`❌ PDF não encontrado: ${book.pdfSrc}`);
      continue;
    }

    fs.copyFileSync(book.pdfSrc,   pdfDest);
    if (fs.existsSync(book.coverSrc)) {
      fs.copyFileSync(book.coverSrc, coverDest);
    }

    // Insert into database with status='ready'
    try {
      rawDb.prepare(`
        INSERT INTO ebooks (
          id, title, subtitle, description, topic, language,
          ai_provider, word_count, chapter_count,
          pdf_path, cover_path, price, status,
          created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, ?, 'existing', 0, 0, ?, ?, ?, 'ready', datetime('now'), datetime('now'))
      `).run(
        ebookId,
        book.title,
        book.description,
        book.topic,
        book.language,
        pdfDest,
        fs.existsSync(book.coverSrc) ? coverDest : null,
        book.price
      );
      console.log(`✅ Injetado: "${book.title}" — id=${ebookId}`);
      console.log(`   PDF:   ${pdfDest}`);
      console.log(`   Cover: ${coverDest}`);
    } catch (e) {
      console.error(`❌ Erro ao inserir "${book.title}": ${e.message}`);
      // Try simpler insert without all fields
      try {
        db.saveEbook({
          id: ebookId,
          title: book.title,
          subtitle: '',
          description: book.description,
          topic: book.topic,
          language: book.language,
          aiProvider: 'existing',
          wordCount: 0,
          chapters: [],
          pdfPath: pdfDest,
          coverPath: fs.existsSync(book.coverSrc) ? coverDest : null,
          price: book.price,
          status: 'ready',
        });
        console.log(`✅ Injetado via saveEbook: "${book.title}"`);
      } catch (e2) {
        console.error(`❌ saveEbook também falhou: ${e2.message}`);
      }
    }
  }

  // Show current queue
  const queue = rawDb.prepare("SELECT id, title, status FROM ebooks WHERE status = 'ready' ORDER BY created_at").all();
  console.log(`\n📚 Fila de publicação (status=ready): ${queue.length} ebooks`);
  for (const e of queue) {
    console.log(`   - [${e.id.slice(0,8)}] "${e.title}"`);
  }

  console.log('\n=== Injeção concluída ===');
  process.exit(0);
}

inject().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
