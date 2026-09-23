'use strict';
/**
 * publicar_kiwify.js — publica e-books na Kiwify a partir da MAQUINA DO LOGIN.
 *
 * Mesmo motivo da Hotmart: a sessao vive no Chrome do dono (a porta e
 * descoberta: 9222, 9223 ou CHROME_CDP_PORT). Os
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
const http = require('http');
const puppeteer = require('puppeteer-core');
const { publicarNaKiwify, credenciais } = require('../src/agents/publisherKiwify');
const { portasCandidatas, escolherPorta } = require('../src/core/navegadorLocal');
const { ehLimiteDeTaxa } = require('../src/agents/kiwifyRegras');
const { filaDaRodada, resumoDaFila } = require('../src/core/filaIdioma');

let log;
try { log = require('../src/core/logger').createLogger('publicarKiwify'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';

const VITRINE = 'https://veloxisit.com.br/livros/';
const TMP = path.join(os.tmpdir(), 'publicar-kiwify');
// A Kiwify estrangula o ritmo (429). Com pausa entre livros o lote anda; sem
// ela, 57 de 60 falharam em segundos (23/09/2026).
const PAUSA_MS = Number(process.env.KIWIFY_PAUSA_MS || 6000);
const DESISTIR_APOS = 5;
const dormir = ms => new Promise(r => setTimeout(r, ms));

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
    db.prepare('CREATE TABLE IF NOT EXISTS kiwify_recusado (ebook_id TEXT PRIMARY KEY, palavra TEXT, quando INTEGER)').run();
    const colunas = db.prepare("PRAGMA table_info(ebooks)").all().map(c => c.name);
    if (!colunas.includes('kiwify_product_id')) db.prepare('ALTER TABLE ebooks ADD COLUMN kiwify_product_id TEXT').run();
    if (!colunas.includes('kiwify_url')) db.prepare('ALTER TABLE ebooks ADD COLUMN kiwify_url TEXT').run();
    // Dois grupos separados: so "pt primeiro" enchia a lista de portugues e o
    // rodizio de idioma nunca via um livro estrangeiro.
    const base = "SELECT id, title, topic, description, language, price FROM ebooks " +
      "WHERE (kiwify_product_id IS NULL OR kiwify_product_id = '') AND pdf_path IS NOT NULL " +
      "AND id NOT IN (SELECT ebook_id FROM kiwify_recusado) AND title IS NOT NULL AND title <> '' ";
    const teto = ${(Number(limite) || 3) * 4};
    const rows = db.prepare(base + "AND LOWER(COALESCE(language,'')) LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all()
      .concat(db.prepare(base + "AND LOWER(COALESCE(language,'')) NOT LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all());
    // O link de entrega e assinado AQUI: o segredo (ENTREGA_SECRET) so existe
    // no servidor. A maquina local nunca ve a chave, so o link pronto.
    let urlEntrega = null;
    try { urlEntrega = require('/app/src/core/entrega').urlEntrega; } catch (e) {}
    for (const r of rows) {
      try { r.link_entrega = urlEntrega ? urlEntrega(r.id) : ''; }
      catch (e) { r.link_entrega = ''; r.sem_entrega = String(e.message).slice(0, 80); }
    }
    console.log('@@' + JSON.stringify(rows));
  `);
  const linha = saida.split('\n').find(l => l.startsWith('@@'));
  return linha ? JSON.parse(linha.slice(2)) : [];
}

/** Livro recusado pelo filtro de conteudo: sai da fila com o motivo registrado. */
function marcarRecusado(id, palavra) {
  rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    db.prepare('CREATE TABLE IF NOT EXISTS kiwify_recusado (ebook_id TEXT PRIMARY KEY, palavra TEXT, quando INTEGER)').run();
    db.prepare('INSERT OR REPLACE INTO kiwify_recusado (ebook_id, palavra, quando) VALUES (?, ?, ?)')
      .run(${JSON.stringify(String(id))}, ${JSON.stringify(String(palavra))}, Date.now());
    console.log('@@ok');
  `);
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

/** A porta do Chrome de automacao muda quando o dono reabre o navegador. */
function responde(porta) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/json/version', timeout: 4000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function principal() {
  const limite = Number(arg('limite', '3'));
  const seco = temFlag('dry-run');
  // Rodizio de idioma: parte das vagas vai para o catalogo estrangeiro, que
  // ficava parado atras de 6.568 livros em portugues.
  const candidatos = buscarPendentes(limite);
  const rodada = Math.floor(Date.now() / 1800000); // gira a cada meia hora
  const pendentes = filaDaRodada(candidatos, limite, { fatiaEstrangeira: Number(process.env.FATIA_ESTRANGEIRA || 0.4), rodada });
  log.info('pendentes para a Kiwify: ' + pendentes.length + ' (' + resumoDaFila(pendentes) + ')' + (seco ? ' (dry-run)' : ''));
  if (!pendentes.length) return { publicados: 0, falhas: 0, recusados: 0 };

  const porta = await escolherPorta(responde, portasCandidatas(process.env));
  if (!porta) throw new Error('CHROME_FORA_DO_AR: nenhuma porta de depuracao respondeu (rode scripts/vigia_navegador.js)');
  log.info('Chrome de automacao na porta ' + porta);
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + porta, defaultViewport: null, protocolTimeout: 180000 });
  const pagina = (await browser.pages()).find(p => /kiwify\.com/.test(p.url())) || await browser.newPage();
  const cred = await credenciais(pagina);
  log.info('sessao da Kiwify pronta');

  let publicados = 0, falhas = 0, recusados = 0, seguidasPorRitmo = 0;
  for (const livro of pendentes) {
    const dados = {
      title: livro.title,
      description: livro.description,
      language: livro.language,
      topic: livro.topic,
      preco: livro.price || 5,
      paginaDeVendas: VITRINE + slug(livro.title) + '/',
      linkDeEntrega: livro.link_entrega || '',
    };
    if (!dados.linkDeEntrega) log.warn('sem link de entrega: "' + umaLinha(livro.title) + '"' + (livro.sem_entrega ? ' (' + umaLinha(livro.sem_entrega, 80) + ')' : ''));
    if (seco) { log.info('[dry-run] publicaria "' + umaLinha(livro.title) + '" entrega=' + (dados.linkDeEntrega ? 'ok' : 'FALTA')); continue; }
    try {
      const r = await publicarNaKiwify(pagina, dados, { cred });
      gravarResultado(livro.id, r.id, r.url);
      publicados++;
      seguidasPorRitmo = 0;
      log.info((r.jaExistia ? 'ja existia' : 'publicado') + ': "' + umaLinha(livro.title) + '" -> ' + r.url);
    } catch (e) {
      falhas++;
      const msg = String((e && e.message) || '');
      const recusa = msg.match(/^KIWIFY_RECUSADO: (.+)$/);
      if (recusa) {
        marcarRecusado(livro.id, recusa[1]);
        recusados++;
        log.warn('fora da fila (filtro de conteudo, palavra "' + umaLinha(recusa[1], 40) + '"): "' + umaLinha(livro.title) + '"');
      } else {
        log.error('FALHA "' + umaLinha(livro.title) + '": ' + umaLinha(msg, 160));
      }
      if (ehLimiteDeTaxa(null, msg)) {
        seguidasPorRitmo++;
        if (seguidasPorRitmo >= DESISTIR_APOS) {
          log.warn('a Kiwify segue estrangulando o ritmo (' + seguidasPorRitmo + ' seguidas) — parando o lote para nao queimar a fila');
          break;
        }
      }
    }
    await dormir(PAUSA_MS);
  }
  browser.disconnect();
  return { publicados, falhas, recusados };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { slug, buscarPendentes, principal };
