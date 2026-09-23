'use strict';
/**
 * publicar_kiwify.js — publica e-books na Kiwify a partir da MAQUINA DO LOGIN.
 *
 * Mesmo motivo da Hotmart: a sessao vive no Chrome do dono (porta 9223). Os
 * livros moram no VPS; daqui so sai o pedido e para ca volta o id do produto.
 *
 * Uso:
 *   node scripts/publicar_kiwify.js --limite=3
 *   node scripts/publicar_kiwify.js --limite=3 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { publicarNaKiwify, credenciais } = require('../src/agents/publisherKiwify');

let log;
try { log = require('../src/core/logger').createLogger('publicarKiwify'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.KIWIFY_CDP || 'http://127.0.0.1:9223';
const VITRINE = 'https://veloxisit.com.br/livros/';
const TMP = path.join(os.tmpdir(), 'publicar-kiwify');

const arg = (nome, padrao) => {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
};
const temFlag = nome => process.argv.includes('--' + nome);
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function rodarNoContainer(js, timeout = 180000) {
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'cmd.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, VPS + ':/tmp/cmd_kiwify.js'], { timeout: 120000 });
  execFileSync('ssh', [VPS, 'docker cp /tmp/cmd_kiwify.js ' + CONTAINER + ':/app/cmd_kiwify.js'], { timeout: 120000, encoding: 'utf8' });
  return execFileSync('ssh', [VPS, 'docker exec ' + CONTAINER + ' sh -c "cd /app && node cmd_kiwify.js"'],
    { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

/** Livros prontos que ainda nao estao na Kiwify. Portugues primeiro (foi o que vendeu). */
function buscarPendentes(limite) {
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    const colunas = db.prepare("PRAGMA table_info(ebooks)").all().map(c => c.name);
    if (!colunas.includes('kiwify_product_id')) db.prepare('ALTER TABLE ebooks ADD COLUMN kiwify_product_id TEXT').run();
    if (!colunas.includes('kiwify_url')) db.prepare('ALTER TABLE ebooks ADD COLUMN kiwify_url TEXT').run();
    const rows = db.prepare(
      "SELECT id, title, topic, description, language, price FROM ebooks " +
      "WHERE (kiwify_product_id IS NULL OR kiwify_product_id = '') AND pdf_path IS NOT NULL " +
      "AND title IS NOT NULL AND title <> '' " +
      "ORDER BY (CASE WHEN LOWER(COALESCE(language,'')) LIKE 'pt%' THEN 0 ELSE 1 END), rowid DESC LIMIT ${Number(limite) || 3}"
    ).all();
    console.log('@@' + JSON.stringify(rows));
  `);
  const linha = saida.split('\n').find(l => l.startsWith('@@'));
  return linha ? JSON.parse(linha.slice(2)) : [];
}

function gravarResultado(id, produtoId, url) {
  rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    db.prepare('UPDATE ebooks SET kiwify_product_id = ?, kiwify_url = ? WHERE id = ?')
      .run(${JSON.stringify(String(produtoId))}, ${JSON.stringify(String(url))}, ${JSON.stringify(String(id))});
    console.log('@@ok');
  `);
}

/** slug da vitrine: mesma regra do gerador de paginas. */
const slug = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function principal() {
  const limite = Number(arg('limite', '3'));
  const seco = temFlag('dry-run');
  const pendentes = buscarPendentes(limite);
  log.info('pendentes para a Kiwify: ' + pendentes.length + (seco ? ' (dry-run)' : ''));
  if (!pendentes.length) return { publicados: 0, falhas: 0 };

  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 180000 });
  const pagina = (await browser.pages()).find(p => /kiwify\.com/.test(p.url())) || await browser.newPage();
  const cred = await credenciais(pagina);
  log.info('sessao da Kiwify pronta');

  let publicados = 0, falhas = 0;
  for (const livro of pendentes) {
    const dados = {
      title: livro.title,
      description: livro.description,
      language: livro.language,
      topic: livro.topic,
      preco: livro.price || 5,
      paginaDeVendas: VITRINE + slug(livro.title) + '/',
    };
    if (seco) { log.info('[dry-run] publicaria "' + umaLinha(livro.title) + '"'); continue; }
    try {
      const r = await publicarNaKiwify(pagina, dados, { cred });
      gravarResultado(livro.id, r.id, r.url);
      publicados++;
      log.info((r.jaExistia ? 'ja existia' : 'publicado') + ': "' + umaLinha(livro.title) + '" -> ' + r.url);
    } catch (e) {
      falhas++;
      log.error('FALHA "' + umaLinha(livro.title) + '": ' + umaLinha(e && e.message, 160));
    }
  }
  browser.disconnect();
  return { publicados, falhas };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { slug, buscarPendentes, principal };
