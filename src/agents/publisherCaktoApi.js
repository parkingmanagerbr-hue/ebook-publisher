'use strict';
/**
 * publisherCaktoApi.js — publica e-book na Cakto pela API, sem navegador.
 *
 * O robo antigo (publishBacklog --plataforma=cakto) dirigia o wizard de
 * /dashboard/products/new. Em 26/09/2026 o wizard mudou: nao havia mais botao
 * "Continuar" nem campo de arquivo na etapa 2 — 0 de 2 publicados, 3 min por
 * livro e o navegador pendurado (foi o que levou a pausar o job no cron em
 * 25/09). Pela API sao tres chamadas e nenhum navegador:
 *
 *   POST  /api/products/            {name, description}     -> 201, cria
 *   GET   /api/product/{id}/                                -> objeto inteiro
 *   PUT   /api/product/{id}/        {...objeto, ...ajustes}  -> entrega, afiliacao, status
 *   PUT   /api/product/{id}/image/  multipart                -> capa
 *
 * A sessao e a mesma ja usada pela higiene: cookie salvo + token de CSRF
 * pedido em /get-csrf-token/ (que tambem GRAVA um cookie novo — precisa
 * mesclar, senao a escrita volta 403).
 *
 * Ritmo: uma chamada a cada 3 s. Rajada aciona o desafio do Cloudflare e
 * derruba a sessao salva (medido na auditoria de 15/09/2026).
 */
const fs = require('fs');
const { corpoDeCriacao, corpoDeAjuste, shortcodeDaOferta, linkDeCheckout, mesmoProdutoCakto, motivoDefinitivo, nomeDeProduto } = require('./caktoApiRegras');
const { ehErroDaLoja } = require('./higieneCakto');

let log;
try { log = require('../core/logger').createLogger('caktoApi'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const API = 'https://api.cakto.com.br/api/';
const PAUSA_MS = parseInt(process.env.CAKTO_PAUSA_MS || '3000', 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Cabecalhos de escrita: cookie salvo + CSRF fresco (o token vem com cookie novo). */
async function cabecalhos() {
  const s = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  const base = {
    accept: 'application/json', 'content-type': 'application/json',
    referer: 'https://app.cakto.com.br/', origin: 'https://app.cakto.com.br',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  let cookies = s.cookies.map(c => c.name + '=' + c.value);
  const r = await fetch(API + 'get-csrf-token/', { headers: { ...base, cookie: cookies.join('; ') } });
  const novos = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]);
  const nomes = new Set(novos.map(c => c.split('=')[0]));
  cookies = cookies.filter(c => !nomes.has(c.split('=')[0])).concat(novos);
  let token = null;
  try { token = (await r.json()).csrfToken; } catch { /* sem corpo */ }
  if (!token) throw new Error('get-csrf-token nao devolveu token (HTTP ' + r.status + ')');
  return { ...base, cookie: cookies.join('; '), 'x-csrftoken': token };
}

async function api(metodo, rota, corpo, H) {
  const r = await fetch(API + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined });
  const t = await r.text();
  if (t.startsWith('<')) {
    const e = new Error('Cakto devolveu HTML (HTTP ' + r.status + ') — Cloudflare ou sessao expirada');
    e.cloudflare = true; e.status = r.status; throw e;
  }
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) {
    const e = new Error(metodo + ' ' + rota + ': HTTP ' + r.status + ' ' + umaLinha(t, 200));
    e.status = r.status; e.corpo = t; e.definitivo = motivoDefinitivo(r.status, t);
    throw e;
  }
  return j;
}

/** Envia a capa (multipart; o content-type sai dos headers para o boundary entrar). */
async function enviarCapa(produtoId, caminho, H) {
  const { 'content-type': _fora, ...semTipo } = H;
  const dados = new FormData();
  dados.append('image', new Blob([fs.readFileSync(caminho)]), require('path').basename(caminho));
  const r = await fetch(API + 'product/' + produtoId + '/image/', { method: 'PUT', headers: semTipo, body: dados });
  if (!r.ok) throw new Error('capa: HTTP ' + r.status + ' ' + umaLinha(await r.text(), 160));
}

/**
 * Publica um livro. Devolve { id, shortcode, checkout, ajustes }.
 * `livro`: { title, description, capa (caminho), entrega (link assinado) }.
 */
async function publicarNaCakto(livro, { H, pausar = dormir } = {}) {
  const cab = H || await cabecalhos();
  const titulo = nomeDeProduto((livro || {}).title || (livro || {}).titulo);
  if (!titulo) throw new Error('CAKTO_SEM_TITULO: livro sem nome');

  const criado = await api('POST', 'products/', corpoDeCriacao(livro), cab);
  const id = criado && criado.id;
  if (!id) throw new Error('CAKTO_SEM_ID: a API aceitou mas nao devolveu id');
  log.info('criado id=' + umaLinha(id, 40) + ' "' + umaLinha(titulo) + '"');
  await pausar(PAUSA_MS);

  const produto = await api('GET', 'product/' + id + '/', null, cab);
  if (!mesmoProdutoCakto(produto.name, titulo)) {
    log.error('PRODUTO_ERRADO na Cakto: id ' + umaLinha(id, 40) + ' e "' + umaLinha(produto.name) + '", nao "' + umaLinha(titulo) + '" — nada alterado');
    throw new Error('CAKTO_PRODUTO_ERRADO: ' + umaLinha(id, 40));
  }
  await pausar(PAUSA_MS);

  const shortcode = shortcodeDaOferta(produto);
  const ajustes = corpoDeAjuste(produto, { entrega: livro.entrega, checkout: linkDeCheckout(shortcode) });
  if (Object.keys(ajustes).length) {
    // A rota nao aceita PATCH em JSON (405): PUT com o produto inteiro.
    await api('PUT', 'product/' + id + '/', { ...produto, ...ajustes }, cab);
    await pausar(PAUSA_MS);
  }
  if (livro.capa && fs.existsSync(livro.capa)) {
    await enviarCapa(id, livro.capa, cab);
    await pausar(PAUSA_MS);
  }
  return { id, shortcode, checkout: linkDeCheckout(shortcode), ajustes };
}

module.exports = { publicarNaCakto, cabecalhos, api, enviarCapa, ehErroDaLoja, API };
