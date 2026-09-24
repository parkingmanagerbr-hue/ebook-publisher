'use strict';
/**
 * publicar_kdp_local.js — publica no KDP a partir da MAQUINA DO LOGIN.
 *
 * Por que (historico registrado em 26/06 e 28/07/2026): pelo VPS o KDP cai em
 * step-up auth (OTP/senha) porque o IP e de datacenter; e os 36 rascunhos
 * antigos da conta NUNCA publicam, mesmo completos — o que funciona e criar
 * titulo NOVO a partir de um Chrome ja logado.
 *
 * KDP Select fica DESLIGADO: o dono decidiu manter os livros vendendo nas tres
 * lojas, e o Select exige exclusividade.
 *
 * Uso:
 *   node scripts/publicar_kdp_local.js --limite=1
 *   node scripts/publicar_kdp_local.js --limite=1 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
const { filaDaRodada, resumoDaFila } = require('../src/core/filaIdioma');
const { comTentativas } = require('../src/core/tentativas');

let log;
try { log = require('../src/core/logger').createLogger('publicarKdp'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const TMP = path.join(os.tmpdir(), 'publicar-kdp');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function rodarNoContainer(js, timeout = 180000) {
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'cmd.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, VPS + ':/tmp/cmd_kdp.js'], { timeout: 120000 });
  execFileSync('ssh', [VPS, 'docker cp /tmp/cmd_kdp.js ' + CONTAINER + ':/app/cmd_kdp.js'], { timeout: 120000, encoding: 'utf8' });
  return execFileSync('ssh', [VPS, 'docker exec ' + CONTAINER + ' sh -c "cd /app && node cmd_kdp.js"'],
    { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

/** Livros com arquivo pronto que ainda nao estao na Amazon. */
function buscarPendentes(limite) {
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    const base = "SELECT id, title, subtitle, topic, description, language, price, pdf_path, cover_path FROM ebooks " +
      "WHERE (amazon_url IS NULL OR amazon_url = '') AND (amazon_product_id IS NULL OR amazon_product_id = '') " +
      "AND pdf_path IS NOT NULL AND cover_path IS NOT NULL AND cover_path <> '' AND title IS NOT NULL AND title <> '' ";
    const teto = ${(Number(limite) || 1) * 8};
    const linhas = db.prepare(base + "AND LOWER(COALESCE(language,'')) LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all()
      .concat(db.prepare(base + "AND LOWER(COALESCE(language,'')) NOT LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all());
    const comArquivo = linhas.filter(e => fs.existsSync(e.pdf_path) && fs.existsSync(e.cover_path));
    console.log('@@' + JSON.stringify(comArquivo));
  `);
  const linha = saida.split('\n').find(l => l.startsWith('@@'));
  return linha ? JSON.parse(linha.slice(2)) : [];
}

function gravarResultado(id, produtoId, url) {
  rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    db.prepare('UPDATE ebooks SET amazon_product_id = ?, amazon_url = ? WHERE id = ?')
      .run(${JSON.stringify(String(produtoId))}, ${JSON.stringify(String(url))}, ${JSON.stringify(String(id))});
    console.log('@@ok');
  `);
}

/** Traz o arquivo do servidor, repetindo quando a queda e de rede. */
async function baixar(remoto, destino) {
  return comTentativas(async () => {
    execFileSync('ssh', [VPS, 'docker cp ' + CONTAINER + ':' + remoto + ' /tmp/kdp_arquivo'], { timeout: 180000 });
    execFileSync('scp', [VPS + ':/tmp/kdp_arquivo', destino], { timeout: 180000 });
    if (!(fs.existsSync(destino) && fs.statSync(destino).size > 1000)) throw new Error('arquivo veio vazio do VPS');
    return true;
  }, { vezes: 3, aoFalhar: (e, n) => log.warn('rede falhou (tentativa ' + n + '): ' + umaLinha(e.message, 80)) });
}

async function principal() {
  const limite = Number(arg('limite', '1'));
  const seco = process.argv.includes('--dry-run');
  const candidatos = buscarPendentes(limite);
  const itens = filaDaRodada(candidatos, limite, {
    fatiaEstrangeira: Number(process.env.FATIA_ESTRANGEIRA || 0.4),
    rodada: Math.floor(Date.now() / 1800000),
  });
  if (!itens.length) { log.info('nada pendente para o KDP'); return { publicados: 0, falhas: 0 }; }
  log.info('KDP: ' + itens.length + ' livro(s) nesta rodada (' + resumoDaFila(itens) + ')' + (seco ? ' (dry-run)' : ''));
  if (seco) { for (const e of itens) log.info('[dry-run] ' + umaLinha(e.title, 60)); return { publicados: 0, falhas: 0 }; }

  // O publisher conecta no Chrome ja logado: sem login, sem OTP, sem senha.
  process.env.KDP_BROWSER_URL = await urlCdpObrigatoria();
  const { publishToAmazon } = require('../src/agents/publisherAmazon');
  fs.mkdirSync(TMP, { recursive: true });

  let publicados = 0, falhas = 0;
  for (const e of itens) {
    const pdfLocal = path.join(TMP, 'livro.pdf');
    const capaLocal = path.join(TMP, 'capa.png');
    try {
      if (!await baixar(e.pdf_path, pdfLocal)) throw new Error('PDF nao veio do VPS');
      if (!await baixar(e.cover_path, capaLocal)) throw new Error('capa nao veio do VPS');
      const r = await publishToAmazon({
        title: e.title, subtitle: e.subtitle, topic: e.topic, description: e.description,
        language: e.language, price: e.price, pdfPath: pdfLocal, coverPath: capaLocal,
        // Sem exclusividade: o mesmo livro segue na Hotmart, Cakto e Kiwify.
        kdpSelect: false,
      });
      if (r && r.success && (r.url || r.productId)) {
        gravarResultado(e.id, r.productId || '', r.url || '');
        publicados++;
        log.info('publicado: "' + umaLinha(e.title, 50) + '" -> ' + umaLinha(r.url || r.productId, 60));
      } else {
        falhas++;
        log.error('FALHA "' + umaLinha(e.title, 50) + '": ' + umaLinha(r && r.error, 160));
      }
    } catch (err) {
      falhas++;
      log.error('FALHA "' + umaLinha(e.title, 50) + '": ' + umaLinha(err && err.message, 160));
    } finally {
      for (const f of [pdfLocal, capaLocal]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
  }
  return { publicados, falhas };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + e.message); process.exit(1); });
}

module.exports = { buscarPendentes, principal };
