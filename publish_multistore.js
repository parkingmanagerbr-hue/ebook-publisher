'use strict';
/**
 * publish_multistore.js — Publica os 3 livros no Hotmart e Cakto
 * Usa os agentes do EbookPublisher já implementados e testados.
 *
 * Livros:
 *   1. Financas Pessoais Descomplicadas
 *   2. Como Sair das Dividas de Forma Definitiva
 *   3. Healthy Weight Loss Without Hunger
 */

const path = require('path');
const fs = require('fs');

// === Configuração de ambiente ===
const BASE = 'C:/Users/m_rov/ClaudeProjects/EbookPublisher';
const TEMP = 'C:/Users/m_rov/AppData/Local/Temp';

process.env.HOTMART_SESSION_FILE = path.join(BASE, 'data/sessions/hotmart.json');
process.env.CAKTO_SESSION_FILE   = path.join(BASE, 'data/sessions/cakto.json');
process.env.SCREENSHOTS_DIR      = path.join(TEMP, 'multistore_screenshots');
process.env.DEFAULT_PRICE        = '29,90';   // Hotmart — BRL, currency mask
process.env.HOTMART_PRICE        = '29,90';
process.env.EBOOK_PRICE          = '29.90';   // Cakto
process.env.CHROME_EXECUTABLE    = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
process.env.CAKTO_EMAIL          = 'mrovariz@hotmail.com';
process.env.CAKTO_PASSWORD       = 'Genia2026$Kdp';

fs.mkdirSync(process.env.SCREENSHOTS_DIR, { recursive: true });

// === Logger simples ===
const LOG_FILE = path.join(TEMP, 'publish_multistore.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// === Livros ===
const BOOKS = [
  {
    title: 'Financas Pessoais Descomplicadas',
    description: 'Guia completo e prático de finanças pessoais para organizar sua vida financeira, sair das dívidas e construir patrimônio com estratégias simples e eficazes. Aprenda a controlar gastos, investir com sabedoria e alcançar a liberdade financeira.',
    topic: 'finanças pessoais',
    pdfPath:   path.join(TEMP, 'financas_pessoais.pdf'),
    coverPath: path.join(TEMP, 'financas_pessoais_cover.png'),
    price: 29.90,
  },
  {
    title: 'Como Sair das Dividas de Forma Definitiva',
    description: 'Estratégias comprovadas para eliminar dívidas e recuperar o controle financeiro. Este guia prático mostra passo a passo como negociar dívidas, cortar despesas desnecessárias e criar hábitos financeiros saudáveis para nunca mais se endividar.',
    topic: 'dívidas finanças',
    pdfPath:   path.join(TEMP, 'dividas.pdf'),
    coverPath: path.join(TEMP, 'dividas_cover.png'),
    price: 29.90,
  },
  {
    title: 'Healthy Weight Loss Without Hunger',
    description: 'Complete practical guide to healthy and sustainable weight loss without hunger. Learn evidence-based strategies for nutrition, metabolism, and lifestyle changes that produce real and lasting results for your health and well-being.',
    topic: 'weight loss health diet',
    pdfPath:   path.join(TEMP, 'healthy_weight.pdf'),
    coverPath: path.join(TEMP, 'healthy_weight_cover.png'),
    price: 29.90,
  },
];

// === Importar agentes ===
const { publishToHotmart } = require(path.join(BASE, 'src/agents/publisherHotmart'));
const { publishToCakto }   = require(path.join(BASE, 'src/agents/publisherCakto'));

// === Runner ===
async function run() {
  log('=== Publicação Multi-Loja: Hotmart + Cakto ===');
  log(`Livros: ${BOOKS.length}`);

  const results = [];

  for (const book of BOOKS) {
    log(`\n--- Livro: "${book.title}" ---`);

    // Verificar arquivos
    const pdfOk   = fs.existsSync(book.pdfPath);
    const coverOk = fs.existsSync(book.coverPath);
    log(`  PDF: ${book.pdfPath} (${pdfOk ? 'OK' : 'MISSING'})`);
    log(`  Cover: ${book.coverPath} (${coverOk ? 'OK' : 'MISSING'})`);

    const bookResult = { title: book.title, hotmart: null, cakto: null };

    // === HOTMART ===
    log(`[Hotmart] Publicando "${book.title}"...`);
    try {
      const hResult = await publishToHotmart({
        title:       book.title,
        description: book.description,
        topic:       book.topic,
        coverPath:   coverOk ? book.coverPath : null,
        pdfPath:     pdfOk ? book.pdfPath : null,
        price:       book.price,
      });
      log(`[Hotmart] Resultado: ${JSON.stringify(hResult)}`);
      bookResult.hotmart = hResult;
    } catch(e) {
      log(`[Hotmart] ERRO: ${e.message}`);
      bookResult.hotmart = { success: false, error: e.message };
    }

    // Pausa entre plataformas
    await new Promise(r => setTimeout(r, 3000));

    // === CAKTO ===
    log(`[Cakto] Publicando "${book.title}"...`);
    try {
      const cResult = await publishToCakto({
        title:       book.title,
        description: book.description,
        topic:       book.topic,
        coverPath:   coverOk ? book.coverPath : null,
        pdfPath:     pdfOk ? book.pdfPath : null,
        price:       book.price,
      });
      log(`[Cakto] Resultado: ${JSON.stringify(cResult)}`);
      bookResult.cakto = cResult;
    } catch(e) {
      log(`[Cakto] ERRO: ${e.message}`);
      bookResult.cakto = { success: false, error: e.message };
    }

    results.push(bookResult);

    // Pausa entre livros
    await new Promise(r => setTimeout(r, 5000));
  }

  // === Resumo final ===
  log('\n=== RESUMO FINAL ===');
  for (const r of results) {
    const hStatus = r.hotmart?.success ? `✅ id=${r.hotmart.hotmartProductId}` : `❌ ${r.hotmart?.error?.slice(0,80)}`;
    const cStatus = r.cakto?.success   ? `✅ id=${r.cakto.caktoProductId}`     : `❌ ${r.cakto?.error?.slice(0,80)}`;
    log(`"${r.title}"`);
    log(`  Hotmart: ${hStatus}`);
    log(`  Cakto:   ${cStatus}`);
  }

  // Salvar JSON
  const outFile = path.join(TEMP, 'publish_multistore_results.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  log(`\nResultados salvos: ${outFile}`);
  log('=== Concluído ===');
}

run().catch(e => {
  log(`FATAL: ${e.message}\n${e.stack}`);
  process.exit(1);
});
