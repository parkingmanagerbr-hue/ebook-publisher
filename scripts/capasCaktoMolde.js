'use strict';
/**
 * capasCaktoMolde.js — poe capa nos produtos da Cakto que estao sem imagem.
 *
 * 01/10/2026: 6.149 produtos sem imagem na Cakto, 342 deles VENDENDO. As capas
 * do disco foram apagadas pela retencao antiga e a capa por IA esta sem cota.
 * Ordem: produto vendendo primeiro. Fonte da capa: a do disco quando ainda
 * existe; senao o molde sem IA (src/agents/capaDeMolde.js).
 *
 * Seguranca: rele o produto antes (ja tem imagem = nao mexe) e confere depois
 * pela API (so conta como feito o que a Cakto devolve com imagem).
 *
 * Uso (no container):
 *   node scripts/capasCaktoMolde.js --varrer          # refaz a lista lendo a Cakto
 *   node scripts/capasCaktoMolde.js --limite=50       # aplica nos proximos 50
 */
const fs = require('fs');
const path = require('path');
const { cabecalhos, enviarCapa, API } = require('../src/agents/publisherCaktoApi');
const { htmlDaCapa, separarTitulo, LARGURA, ALTURA } = require('../src/agents/capaDeMolde');

let log;
try { log = require('../src/core/logger').createLogger('capasCaktoMolde'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const temFlag = (n) => process.argv.includes('--' + n);
const LISTA = process.env.CAKTO_SEM_CAPA || '/app/data/cakto_sem_capa.json';
const COVERS = process.env.COVERS_DIR || '/app/data/covers';
const PAUSA_MS = parseInt(process.env.CAKTO_PAUSA_MS || '1500', 10);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const umaLinha = (s, n = 120) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const chave = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

async function lerJson(rota, H) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(API + rota, { headers: H });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (_) { /* tenta de novo */ }
    await dormir(2000 * (t + 1));
  }
  throw new Error('Cakto nao respondeu: ' + rota);
}

/** Relê a Cakto inteira e grava quem esta sem imagem, vendendo primeiro. */
async function varrer(H) {
  const primeira = await lerJson('products/?page=1&limit=100', H);
  const paginas = Math.ceil(primeira.count / 100);
  const todos = [...primeira.results];
  for (let p = 2; p <= paginas; p += 5) {
    const lote = await Promise.all(Array.from({ length: Math.min(5, paginas - p + 1) }, (_, i) => lerJson('products/?page=' + (p + i) + '&limit=100', H)));
    for (const l of lote) todos.push(...((l && l.results) || []));
  }
  const sem = todos.filter((x) => !x.image && x.status !== 'deleted')
    .map((x) => ({ id: x.id, nome: x.name, status: x.status }))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
  fs.writeFileSync(LISTA + '.tmp', JSON.stringify(sem));
  fs.renameSync(LISTA + '.tmp', LISTA);
  log.info('varredura: ' + todos.length + ' produtos, ' + sem.length + ' sem imagem (' + sem.filter((x) => x.status === 'active').length + ' vendendo)');
  return sem;
}

function prepararBanco(db) {
  db.exec('CREATE TABLE IF NOT EXISTS cakto_capa_molde (produto TEXT PRIMARY KEY, resultado TEXT, fonte TEXT, quando INTEGER)');
}

/** Livro do banco pelo nome do produto, so quando o nome e unico. */
function livrosPorNome(db) {
  const mapa = new Map();
  const linhas = db.prepare("SELECT id, title, subtitle, language, cover_path, cakto_nome FROM ebooks WHERE COALESCE(cakto_product_id,'') <> ''").all();
  for (const e of linhas) {
    const k = chave(e.cakto_nome || e.title);
    mapa.set(k, mapa.has(k) ? null : e);
  }
  return mapa;
}

async function principal() {
  const db = require('../src/core/database').getDb();
  prepararBanco(db);
  const H = await cabecalhos();
  const lista = temFlag('varrer') || !fs.existsSync(LISTA) ? await varrer(H) : JSON.parse(fs.readFileSync(LISTA, 'utf8'));
  if (temFlag('varrer') && !temFlag('aplicar')) return;
  const limite = Number(arg('limite', '50')) || 50;
  const feitos = new Set(db.prepare("SELECT produto FROM cakto_capa_molde WHERE resultado = 'ok'").all().map((r) => r.produto));
  const fila = lista.filter((p) => !feitos.has(p.id)).slice(0, limite);
  if (!fila.length) { log.info('nada pendente'); return { pendentes: 0 }; }

  const porNome = livrosPorNome(db);
  const grava = db.prepare('INSERT OR REPLACE INTO cakto_capa_molde (produto, resultado, fonte, quando) VALUES (?, ?, ?, ?)');
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const resumo = { fila: fila.length, ok: 0, jaTinha: 0, falhas: 0, doDisco: 0, doMolde: 0 };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: LARGURA, height: ALTURA });
    fs.mkdirSync(COVERS, { recursive: true });
    for (const p of fila) {
      try {
        const atual = await lerJson('product/' + p.id + '/', H);
        if (!atual) { grava.run(p.id, 'inexistente', null, Date.now()); continue; }
        if (atual.image) { resumo.jaTinha++; grava.run(p.id, 'ok', 'ja-tinha', Date.now()); continue; }

        const e = porNome.get(chave(p.nome)) || null;
        let caminho = e && e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
        let fonte = 'disco';
        if (!caminho) {
          const nome = separarTitulo(p.nome);
          const titulo = e ? (e.title || nome.titulo) : nome.titulo;
          const subtitulo = e ? (e.subtitle || nome.subtitulo) : nome.subtitulo;
          await page.setContent(htmlDaCapa({ titulo, subtitulo, idioma: e && e.language }), { waitUntil: 'load' });
          caminho = path.join(COVERS, 'cover_molde_' + String(p.id).slice(0, 8) + '.jpg');
          await page.screenshot({ path: caminho, type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: LARGURA, height: ALTURA } });
          fonte = 'molde';
          // O livro ligado guarda a capa nova: a entrega e a Hotmart passam a te-la.
          if (e && !(e.cover_path && fs.existsSync(e.cover_path))) db.prepare('UPDATE ebooks SET cover_path = ? WHERE id = ?').run(caminho, e.id);
        }
        await enviarCapa(p.id, caminho, H);
        await dormir(PAUSA_MS);
        const depois = await lerJson('product/' + p.id + '/', H);
        if (depois && depois.image) {
          resumo.ok++; resumo[fonte === 'disco' ? 'doDisco' : 'doMolde']++;
          grava.run(p.id, 'ok', fonte, Date.now());
        } else {
          resumo.falhas++;
          grava.run(p.id, 'nao-gravou', fonte, Date.now());
          log.warn('capa enviada mas a Cakto nao mostra imagem: ' + umaLinha(p.nome, 60));
        }
      } catch (err) {
        resumo.falhas++;
        grava.run(p.id, 'erro', null, Date.now());
        log.error('falha ' + String(p.id).slice(0, 8) + ' "' + umaLinha(p.nome, 50) + '": ' + umaLinha(err && err.message, 160));
        if (/HTML|Cloudflare|sessao/i.test(String(err && err.message))) break; // ambiente caiu: para o lote
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log.info('resumo: ' + JSON.stringify(resumo));
  console.log(JSON.stringify(resumo));
  return resumo;
}

module.exports = { principal, livrosPorNome, prepararBanco };

if (require.main === module) principal().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
