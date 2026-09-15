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

function assinar(ebookId, env) {
  return crypto.createHmac('sha256', segredo(env)).update('entrega:' + ebookId).digest('base64url').slice(0, 32);
}

function gerarToken(ebookId, env) {
  if (!ID_VALIDO.test(String(ebookId))) throw new Error('id de e-book invalido');
  return ebookId + '.' + assinar(ebookId, env);
}

/** Devolve o id do e-book se o token for autentico; senao null. */
function verificarToken(token, env) {
  const m = /^([A-Za-z0-9-]{8,64})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const esperado = Buffer.from(assinar(m[1], env));
  const recebido = Buffer.from(m[2]);
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido) ? m[1] : null;
}

function urlEntrega(ebookId, env = process.env) {
  const base = (env.PUBLIC_BASE_URL || 'https://publisher.veloxisit.com.br').replace(/\/+$/, '');
  return base + '/entrega/' + gerarToken(ebookId, env);
}

/** Nome de arquivo legivel e seguro a partir do titulo. */
function nomeArquivo(titulo) {
  const limpo = String(titulo || 'ebook').normalize('NFKC')
    .replace(CONTROLE_E_PROIBIDOS, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return (limpo || 'ebook') + '.pdf';
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

module.exports = { gerarToken, verificarToken, urlEntrega, nomeArquivo, criarRota, SEGREDO_PADRAO_INSEGURO };
