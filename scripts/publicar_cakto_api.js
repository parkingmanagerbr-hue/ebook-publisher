'use strict';
/**
 * publicar_cakto_api.js — publica e-books na Cakto pela API, rodando DENTRO do
 * container (a sessao da Cakto e cookie salvo, nao depende da maquina do dono).
 *
 * Substitui `publishBacklog --plataforma=cakto`, que dirigia o wizard do
 * painel e parou de funcionar em 26/09/2026 (sem botao "Continuar", sem campo
 * de arquivo: 0 de 2 publicados, 3 min por livro).
 *
 * Rodizio de idioma: parte das vagas vai para o catalogo estrangeiro, senao os
 * milhares de livros em portugues nunca deixam um estrangeiro passar.
 *
 * Uso (dentro do container):
 *   node scripts/publicar_cakto_api.js --limite=6
 *   node scripts/publicar_cakto_api.js --limite=6 --dry-run
 */
const fs = require('fs');
const { publicarNaCakto, cabecalhos } = require('../src/agents/publisherCaktoApi');
const { ehErroDaLoja } = require('../src/agents/higieneCakto');
const { resumoDaPublicacao, semTitulosJaPublicados } = require('../src/agents/caktoApiRegras');
const { filaDaRodada, resumoDaFila } = require('../src/core/filaIdioma');
const { travar } = require('../src/core/travaLocal');

let log;
try { log = require('../src/core/logger').createLogger('publicarCakto'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const temFlag = n => process.argv.includes('--' + n);
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

async function principal() {
  const limite = Number(arg('limite', '6'));
  const seco = temFlag('dry-run');
  const soltar = seco ? () => {} : travar('cakto', { avisar: m => log.warn(m) });
  if (!soltar) { log.warn('ja existe um publicador da Cakto rodando — saindo'); return { publicados: 0, falhas: 0, recusados: 0, travado: true }; }
  try { return await rodar(limite, seco); } finally { soltar(); }
}

async function rodar(limite, seco) {

  const db = require('../src/core/database').getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS cakto_recusado (ebook_id TEXT PRIMARY KEY, motivo TEXT, quando INTEGER)').run();

  const base = "SELECT id, title, description, language, cover_path, pdf_path FROM ebooks " +
    "WHERE (cakto_product_id IS NULL OR cakto_product_id = '') AND pdf_path IS NOT NULL AND pdf_path <> '' " +
    "AND id NOT IN (SELECT ebook_id FROM cakto_recusado) AND title IS NOT NULL AND title <> '' ";
  const teto = Math.max(4, limite * 4);
  const candidatos = db.prepare(base + "AND LOWER(COALESCE(language,'')) LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all()
    .concat(db.prepare(base + "AND LOWER(COALESCE(language,'')) NOT LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all());

  // Titulo que ja tem produto na Cakto nao volta para a fila: 66 de 1.123
  // produtos lidos em 26/09/2026 tinham nome repetido (ate 4 copias), e
  // duplicata em marketplace nao se desfaz sozinha.
  const jaPublicados = db.prepare(
    "SELECT title FROM ebooks WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' AND title IS NOT NULL"
  ).all().map(r => r.title);
  const semRepetidos = semTitulosJaPublicados(candidatos, jaPublicados);
  if (semRepetidos.length !== candidatos.length) {
    log.info('fora da fila por titulo ja publicado na Cakto: ' + (candidatos.length - semRepetidos.length));
  }

  const rodada = Math.floor(Date.now() / 1800000);
  const pendentes = filaDaRodada(semRepetidos, limite, { fatiaEstrangeira: Number(process.env.FATIA_ESTRANGEIRA || 0.4), rodada });
  log.info('pendentes para a Cakto: ' + pendentes.length + ' (' + resumoDaFila(pendentes) + ')' + (seco ? ' (dry-run)' : ''));
  if (!pendentes.length) return { publicados: 0, falhas: 0, recusados: 0 };

  let urlEntrega = null;
  try { urlEntrega = require('../src/core/entrega').urlEntrega; } catch (_) { /* sem segredo: publica pausado */ }

  const H = await cabecalhos();
  const grava = db.prepare('UPDATE ebooks SET cakto_product_id = ? WHERE id = ?');
  const recusa = db.prepare('INSERT OR REPLACE INTO cakto_recusado (ebook_id, motivo, quando) VALUES (?,?,?)');

  let publicados = 0, falhas = 0, recusados = 0;
  for (const e of pendentes) {
    let entrega = '';
    try { entrega = urlEntrega ? urlEntrega(e.id) : ''; } catch (err) { entrega = ''; }
    if (!entrega) log.warn('sem link de entrega: "' + umaLinha(e.title) + '" — nasce pausado');
    if (seco) { log.info('[dry-run] publicaria "' + umaLinha(e.title) + '" entrega=' + (entrega ? 'ok' : 'FALTA')); continue; }
    try {
      const capa = e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
      const r = await publicarNaCakto({ title: e.title, description: e.description, entrega, capa }, { H });
      // O que o resto do sistema chama de cakto_product_id e o shortcode da
      // oferta (e o que /api/offers/{shortcode}/ aceita).
      if (r.shortcode) grava.run(r.shortcode, e.id);
      publicados++;
      log.info('publicado ' + resumoDaPublicacao(e.title, r.shortcode, r.ajustes) + ' -> ' + r.checkout);
    } catch (err) {
      falhas++;
      const msg = umaLinha(err && err.message, 160);
      log.error('FALHA "' + umaLinha(e.title) + '": ' + msg);
      if (err && err.definitivo) {
        recusa.run(e.id, err.definitivo, Date.now());
        recusados++;
        log.warn('fora da fila (' + err.definitivo + '): "' + umaLinha(e.title) + '"');
        if (err.definitivo === 'limite de plano') { log.warn('a conta bateu o limite de produtos — parando a rodada'); break; }
      }
      if (err && err.cloudflare) { log.warn('Cloudflare barrou — parando esta rodada'); break; }
      if (ehErroDaLoja(err && err.status, msg)) { log.warn('a Cakto esta respondendo erro de servidor — parando a rodada'); break; }
    }
  }
  return { publicados, falhas, recusados };
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal };
