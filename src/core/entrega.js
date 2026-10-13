'use strict';
/**
 * entrega.js — link de download do e-book para quem comprou fora da Hotmart.
 *
 * A Cakto entrega por "link externo" (campo emailAccessLink do produto), e esse
 * campo estava VAZIO nos produtos: o comprador pagava e nao recebia nada
 * (verificado em 15/09/2026). A Hotmart guarda o arquivo; a Cakto nao — o PDF
 * precisa ser servido daqui.
 *
 * O link leva o id do e-book e uma assinatura HMAC: nao da para trocar o id e
 * baixar outro livro, e nao existe lista para enumerar. Nao expira, porque o
 * comprador volta ao e-mail semanas depois. Para um produto de R$ 5 isso basta;
 * quem compartilhar o link compartilharia o PDF de qualquer jeito.
 */
const crypto = require('crypto');
const path = require('path');

const SEGREDO_PADRAO_INSEGURO = 'genia-ebook-secret-2026-change-in-prod';

function segredo(env = process.env) {
  const s = env.ENTREGA_SECRET || env.JWT_SECRET || '';
  // Com o segredo padrao do codigo, qualquer um que leia o repositorio forjaria
  // links. Melhor nao entregar que entregar para todo mundo.
  if (!s || s === SEGREDO_PADRAO_INSEGURO) throw new Error('ENTREGA_SECRET/JWT_SECRET ausente ou padrao');
  return s;
}

// Montado por codigo: escrito como escape literal, a edicao ja trocou a barra
// por um NUL de verdade neste arquivo.
const CONTROLE_E_PROIBIDOS = new RegExp('[' + String.fromCharCode(92, 92) + '/:*?"<>|' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']+', 'g');

const ID_VALIDO = /^[A-Za-z0-9-]{8,64}$/;

// FINALIDADE entra na assinatura. O token do PDF leva o id inteiro do livro, e
// o MP3 tem o mesmo id: com uma assinatura so, quem comprou o e-book de R$ 4,99
// trocaria /entrega/ por /audio/ no proprio link e levaria o audiolivro de
// R$ 9,90. Cada finalidade assina um texto diferente — um token nunca vale na
// rota do outro.
const FINALIDADES = { entrega: 'entrega:', audio: 'audio:' };

function assinar(ebookId, env, finalidade = 'entrega') {
  if (!FINALIDADES[finalidade]) throw new Error('finalidade de link desconhecida');
  return crypto.createHmac('sha256', segredo(env)).update(FINALIDADES[finalidade] + ebookId).digest('base64url').slice(0, 32);
}

function gerarToken(ebookId, env, finalidade = 'entrega') {
  if (!ID_VALIDO.test(String(ebookId))) throw new Error('id de e-book invalido');
  return ebookId + '.' + assinar(ebookId, env, finalidade);
}

/** Devolve o id do e-book se o token for autentico para a finalidade; senao null. */
function verificarToken(token, env, finalidade = 'entrega') {
  const m = /^([A-Za-z0-9-]{8,64})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const esperado = Buffer.from(assinar(m[1], env, finalidade));
  const recebido = Buffer.from(m[2]);
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido) ? m[1] : null;
}

function baseUrl(env) {
  return (env.PUBLIC_BASE_URL || 'https://publisher.veloxisit.com.br').replace(/\/+$/, '');
}

function urlEntrega(ebookId, env = process.env) {
  return baseUrl(env) + '/entrega/' + gerarToken(ebookId, env);
}

/** Link do MP3 do livro `ebookId` (o id do ORIGINAL: e o nome do arquivo). */
function urlAudio(ebookId, env = process.env) {
  return baseUrl(env) + '/audio/' + gerarToken(ebookId, env, 'audio');
}

/** Nome de arquivo legivel e seguro a partir do titulo. */
function nomeArquivo(titulo, extensao = '.pdf') {
  const limpo = String(titulo || 'ebook').normalize('NFKC')
    .replace(CONTROLE_E_PROIBIDOS, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return (limpo || 'ebook') + extensao;
}

/**
 * Handler express. `buscar(id)` devolve {title, pdf_path} ou null — injetado
 * para o teste nao depender do banco real.
 */
function criarRota(buscar, fs = require('fs'), env = process.env) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    let id;
    try { segredo(env); id = verificarToken(req.params.token, env); }
    catch { return res.status(503).send('Entrega indisponivel no momento.'); }
    if (!id) return res.status(404).send('Link invalido.');
    const e = buscar(id);
    if (!e || !e.pdf_path || !fs.existsSync(e.pdf_path)) {
      return res.status(410).send('Arquivo indisponivel. Responda o e-mail da compra que enviamos o seu e-book.');
    }
    const nome = nomeArquivo(e.title);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', "attachment; filename=\"ebook.pdf\"; filename*=UTF-8''" + encodeURIComponent(nome));
    return res.sendFile(path.resolve(e.pdf_path));
  };
}

/**
 * Handler do audio. `dir` e a pasta dos MP3; `buscarTitulo(id)` da o nome
 * legivel do arquivo (null serve: sai "audiolivro.mp3"). Token invalido
 * responde 404 sem dizer por que — nao ensina quem tenta adivinhar. O log leva
 * so o comeco do id, nunca o token: o token e a propria credencial de download.
 */
function criarRotaAudio({ dir, buscarTitulo = () => null, log = null, fs = require('fs'), env = process.env }) {
  const registrar = (nivel, msg) => { try { if (log) log[nivel](msg); } catch (_) { /* protocolo: log nao derruba o download */ } };
  return (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    let id;
    try { segredo(env); id = verificarToken(req.params.token, env, 'audio'); }
    catch {
      registrar('error', '[audio] sem segredo de assinatura — download recusado');
      return res.status(503).send('Download indisponivel no momento.');
    }
    if (!id) {
      registrar('warn', '[audio] token recusado');
      return res.status(404).send('Nao encontrado.');
    }
    const arquivo = path.join(dir, id + '.mp3');
    if (!fs.existsSync(arquivo)) {
      registrar('error', '[audio] MP3 ausente para livro ' + id.slice(0, 8) + ' — comprador com link valido sem arquivo');
      return res.status(404).send('Arquivo indisponivel. Responda o e-mail da compra que enviamos o seu audiolivro.');
    }
    let titulo = null;
    try { titulo = buscarTitulo(id); } catch (_) { titulo = null; }
    const nome = nomeArquivo(titulo || 'audiolivro', '.mp3');
    registrar('info', '[audio] entregue livro ' + id.slice(0, 8) + (req.headers && req.headers.range ? ' (trecho)' : ''));
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', "attachment; filename=\"audiolivro.mp3\"; filename*=UTF-8''" + encodeURIComponent(nome));
    return res.sendFile(path.resolve(arquivo));
  };
}

// So o audio de dominio publico (gutenberg-<id>.mp3, ver gutenbergAgent) e
// servido sem assinatura. O MP3 de livro a venda tem o id do livro no nome e
// ficava publico em /audiobooks/<id>.mp3 — confirmado em 13/10/2026 com
// resposta 206 audio/mpeg sem credencial nenhuma.
const AUDIO_PUBLICO = /^\/gutenberg-[A-Za-z0-9_-]+\.mp3$/;

/** Middleware na frente do estatico de /audiobooks: fora do padrao, 404. */
function soAudioPublico(req, res, next) {
  if (AUDIO_PUBLICO.test(req.path)) return next();
  return res.status(404).send('Nao encontrado.');
}

module.exports = { gerarToken, verificarToken, urlEntrega, urlAudio, nomeArquivo, criarRota, criarRotaAudio, soAudioPublico, SEGREDO_PADRAO_INSEGURO };
