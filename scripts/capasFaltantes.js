'use strict';
/**
 * capasFaltantes.js — recria a capa dos livros cujo arquivo sumiu do disco.
 *
 * 07/10/2026: 4.054 dos 14.245 livros apontavam para uma capa que nao existe
 * mais (a retencao antiga apagou os arquivos). As lojas ja tinham imagem em boa
 * parte, mas tudo que le a capa do DISCO ficava sem: a capa da Kiwify pulava o
 * produto ("sem-capa"), a vitrine e qualquer republicacao. A capa de molde nao
 * usa IA (src/agents/capaDeMolde.js); o livro passa a apontar para ela.
 *
 * Nunca sobrescreve capa que existe: so mexe em livro cujo arquivo sumiu.
 *
 * Uso (no container):
 *   node scripts/capasFaltantes.js                # relatorio
 *   node scripts/capasFaltantes.js --aplicar --limite=1
 */
const fs = require('fs');
const path = require('path');
const { htmlDaCapa, separarTitulo, LARGURA, ALTURA } = require('../src/agents/capaDeMolde');

let log;
try { log = require('../src/core/logger').createLogger('capasFaltantes'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const COVERS = process.env.COVERS_DIR || '/app/data/covers';
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/**
 * Livros que precisam de capa nova: com titulo e com o arquivo da capa ausente.
 * Os que estao a venda vem primeiro (Kiwify, que pula sem capa; depois Hotmart e
 * Cakto). `existe` e injetavel para o teste. Pura.
 */
function filaDeCapas(livros, existe = fs.existsSync) {
  const peso = l => (l.kiwify_product_id ? 0 : l.hotmart_product_id ? 1 : l.cakto_product_id ? 2 : 3);
  return (livros || [])
    .filter(l => l && l.id && String(l.title || '').trim() && !(l.cover_path && existe(l.cover_path)))
    .sort((a, b) => peso(a) - peso(b));
}

/** Caminho da capa nova: nome derivado do id (republicar nao duplica arquivo). Pura. */
function caminhoDaCapa(id, pasta = COVERS) {
  return path.join(pasta, 'cover_molde_livro_' + String(id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 36) + '.jpg');
}

async function principal() {
  const aplicar = process.argv.includes('--aplicar');
  const limite = Number(arg('limite', '100000')) || 100000;
  const db = require('../src/core/database').getDb();
  const livros = db.prepare('SELECT id, title, subtitle, language, cover_path, kiwify_product_id, hotmart_product_id, cakto_product_id FROM ebooks').all();
  const fila = filaDeCapas(livros).slice(0, limite);
  const resumo = { livros: livros.length, semCapa: filaDeCapas(livros).length, fila: fila.length, feitas: 0, falhas: 0 };
  log.info('livros ' + resumo.livros + ', capa sumida ' + resumo.semCapa + (aplicar ? ', aplicando ' + fila.length : ' (relatorio)'));
  if (!aplicar || !fila.length) { console.log(JSON.stringify(resumo)); return resumo; }

  fs.mkdirSync(COVERS, { recursive: true });
  const grava = db.prepare('UPDATE ebooks SET cover_path = ? WHERE id = ?');
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: LARGURA, height: ALTURA });
    for (const l of fila) {
      try {
        const nome = separarTitulo(l.title);
        const subtitulo = l.subtitle || nome.subtitulo;
        await page.setContent(htmlDaCapa({ titulo: l.subtitle ? l.title : nome.titulo, subtitulo, idioma: l.language }), { waitUntil: 'load' });
        const destino = caminhoDaCapa(l.id);
        const tmp = destino + '.tmp.jpg';
        await page.screenshot({ path: tmp, type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: LARGURA, height: ALTURA } });
        if (!(fs.statSync(tmp).size > 10000)) throw new Error('imagem gerada pequena demais');
        fs.renameSync(tmp, destino); // temporario + rename: falha no meio nao deixa arquivo pela metade
        grava.run(destino, l.id);
        resumo.feitas++;
        if (resumo.feitas % 200 === 0) log.info('capas recriadas: ' + resumo.feitas + '/' + fila.length);
      } catch (e) {
        resumo.falhas++;
        log.error('falha ' + String(l.id).slice(0, 8) + ' "' + umaLinha(l.title, 50) + '": ' + umaLinha(e.message, 120));
      }
    }
  } finally { await browser.close().catch(() => {}); }
  log.info('resumo: ' + JSON.stringify(resumo));
  console.log(JSON.stringify(resumo));
  return resumo;
}

module.exports = { filaDeCapas, caminhoDaCapa, principal };

if (require.main === module) principal().catch(e => { log.error('ERRO ' + umaLinha(e.message, 200)); process.exit(1); });
