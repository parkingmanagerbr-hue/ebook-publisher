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
const { resumoDaPublicacao, nomeDistintoCakto, chaveDeTitulo } = require('../src/agents/caktoApiRegras');
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
  // Guarda o nome de fato usado na loja: o titulo do livro pode ter entrado
  // composto com o subtitulo, e a comparacao da proxima rodada precisa ser
  // exata (senao republica o mesmo nome).
  const colunas = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  if (!colunas.includes('cakto_nome')) db.prepare('ALTER TABLE ebooks ADD COLUMN cakto_nome TEXT').run();

  // Titulo repetido NAO sai mais da fila: entra com o subtitulo proprio do
  // livro (ver nomeDistintoCakto). Em 27/09/2026, 1.679 dos 1.681 pendentes
  // tinham titulo ja publicado — descartar todos deixava o catalogo parado.
  const base = "SELECT id, title, subtitle, description, language, cover_path, pdf_path FROM ebooks " +
    "WHERE (cakto_product_id IS NULL OR cakto_product_id = '') AND pdf_path IS NOT NULL AND pdf_path <> '' " +
    "AND id NOT IN (SELECT ebook_id FROM cakto_recusado) AND title IS NOT NULL AND title <> '' ";
  // Teto generoso de proposito: o descarte por nome repetido acontece DEPOIS
  // da consulta, e com teto curto os poucos livros publicaveis ficam
  // escondidos atras de centenas de duplicados — a fila devolvia zero com 11
  // livros prontos (27/09/2026). A consulta e local e a fila cabe inteira.
  const teto = Math.max(1000, limite * 4);
  const candidatos = db.prepare(base + "AND LOWER(COALESCE(language,'')) LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all()
    .concat(db.prepare(base + "AND LOWER(COALESCE(language,'')) NOT LIKE 'pt%' ORDER BY rowid DESC LIMIT " + teto).all());

  // Nomes que JA estao na loja. `cakto_nome` guarda o nome de fato usado (pode
  // ser o composto com subtitulo); sem ele, cai no titulo.
  const usados = new Set(db.prepare(
    "SELECT COALESCE(NULLIF(cakto_nome, ''), title) AS n FROM ebooks " +
    "WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' AND COALESCE(NULLIF(cakto_nome, ''), title) IS NOT NULL"
  ).all().map(r => chaveDeTitulo(r.n)));

  // Cada candidato recebe o nome com que pode entrar; quem nao tem nome
  // distinto possivel sai da fila (sem inventar "Titulo 2").
  let semNome = 0;
  const comNome = [];
  for (const c of candidatos) {
    const nome = nomeDistintoCakto(c, usados);
    if (!nome) { semNome++; continue; }
    usados.add(chaveDeTitulo(nome));   // nao repetir dentro do proprio lote
    comNome.push({ ...c, nomeNaLoja: nome });
  }
  if (semNome) log.info('fora da fila por nao ter nome distinto possivel: ' + semNome);

  // ARQUIVO DE VERDADE, nao so o caminho no banco: 923 dos 924 pendentes
  // tinham pdf_path preenchido e o arquivo SUMIDO do disco (27/09/2026).
  // Publicar assim cria produto que ja nasce pausado por falta de entrega —
  // trabalho a toa e catalogo sujo.
  const antesDoArquivo = comNome.length;
  const comArquivo = comNome.filter(l => { try { return fs.statSync(l.pdf_path).size > 1000; } catch (_) { return false; } });
  if (comArquivo.length !== antesDoArquivo) {
    log.info('fora da fila por PDF ausente ou vazio: ' + (antesDoArquivo - comArquivo.length));
  }

  const rodada = Math.floor(Date.now() / 1800000);
  const pendentes = filaDaRodada(comArquivo, limite, { fatiaEstrangeira: Number(process.env.FATIA_ESTRANGEIRA || 0.4), rodada });
  log.info('pendentes para a Cakto: ' + pendentes.length + ' (' + resumoDaFila(pendentes) + ')' + (seco ? ' (dry-run)' : ''));
  if (!pendentes.length) return { publicados: 0, falhas: 0, recusados: 0 };

  let urlEntrega = null;
  try { urlEntrega = require('../src/core/entrega').urlEntrega; } catch (_) { /* sem segredo: publica pausado */ }

  const H = await cabecalhos();
  const grava = db.prepare('UPDATE ebooks SET cakto_product_id = ?, cakto_nome = ? WHERE id = ?');
  const recusa = db.prepare('INSERT OR REPLACE INTO cakto_recusado (ebook_id, motivo, quando) VALUES (?,?,?)');

  let publicados = 0, falhas = 0, recusados = 0;
  for (const e of pendentes) {
    let entrega = '';
    try { entrega = urlEntrega ? urlEntrega(e.id) : ''; } catch (err) { entrega = ''; }
    if (!entrega) log.warn('sem link de entrega: "' + umaLinha(e.title) + '" — nasce pausado');
    if (seco) { log.info('[dry-run] publicaria "' + umaLinha(e.nomeNaLoja) + '" entrega=' + (entrega ? 'ok' : 'FALTA')); continue; }
    try {
      const capa = e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
      const r = await publicarNaCakto({ title: e.nomeNaLoja, description: e.description, entrega, capa }, { H });
      // O que o resto do sistema chama de cakto_product_id e o shortcode da
      // oferta (e o que /api/offers/{shortcode}/ aceita).
      if (r.shortcode) grava.run(r.shortcode, e.nomeNaLoja, e.id);
      publicados++;
      log.info('publicado ' + resumoDaPublicacao(e.nomeNaLoja, r.shortcode, r.ajustes) + ' -> ' + r.checkout);
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
