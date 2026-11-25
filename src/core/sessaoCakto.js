'use strict';
/**
 * sessaoCakto.js — renova o cookie salvo da Cakto a partir do Chrome da VPS.
 *
 * A API da Cakto (publisherCaktoApi) le o cookie de data/sessions/cakto.json, e
 * ninguem atualizava esse arquivo: em 25/11/2026 a sessao venceu, o dono logou
 * pela tela remota e a publicacao continuou em 401 — 57 falhas seguidas — porque
 * o login novo ficou so no navegador. Quando a API responde 401, copiamos os
 * cookies da Cakto do Chrome (onde o dono loga) para o arquivo e tentamos de novo.
 *
 * Nada aqui imprime valor de cookie: o log leva so a contagem.
 */
const fs = require('fs');

const ARQUIVO = process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json';

/** Resposta da API que significa "sessao recusada". Pura. */
function ehSemSessao(mensagem) {
  return /HTTP 401\b/.test(String(mensagem || ''));
}

/** So os cookies do dominio da Cakto (app., api., sso. e o proprio). Pura. */
function cookiesDaCakto(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter(c => c && /(^|\.)cakto\.com\.br$/.test(String(c.domain || '')));
}

/** Todos os cookies do Chrome de automacao, pelo protocolo de depuracao. */
async function cookiesDoChrome() {
  const puppeteer = require('puppeteer');
  const { urlCdpObrigatoria } = require('./cdpLocal');
  const browser = await puppeteer.connect({ browserURL: await urlCdpObrigatoria(), defaultViewport: null });
  try {
    const sessao = await browser.target().createCDPSession();
    const { cookies } = await sessao.send('Storage.getCookies');
    return cookies;
  } finally { browser.disconnect(); }
}

/**
 * Copia os cookies da Cakto do Chrome para o arquivo de sessao.
 * Sem `sessionid` no Chrome (ninguem logou) o arquivo NAO e tocado.
 * @returns {Promise<{ok:boolean, n?:number, motivo?:string}>}
 */
async function renovarDoChrome({ lerCookies = cookiesDoChrome, arquivo = ARQUIVO, disco = fs, agora = () => new Date() } = {}) {
  let todos;
  try { todos = await lerCookies(); }
  catch (e) { return { ok: false, motivo: 'Chrome nao respondeu: ' + String(e && e.message).slice(0, 80) }; }
  const ck = cookiesDaCakto(todos);
  if (!ck.some(c => c.name === 'sessionid')) return { ok: false, motivo: 'sem sessionid da Cakto no Chrome (logar pela tela remota)' };

  let antigo = {};
  try { antigo = JSON.parse(disco.readFileSync(arquivo, 'utf8')); disco.copyFileSync(arquivo, arquivo + '.bak'); }
  catch (_) { /* protocolo: arquivo ausente ou ilegivel — o novo nasce do zero */ }
  const quando = agora().toISOString();
  const novo = { ...antigo, platform: antigo.platform || 'cakto', cookies: ck, cookieCount: ck.length, savedAt: quando, savedAtHuman: quando, lastRenewed: quando };
  disco.writeFileSync(arquivo + '.tmp', JSON.stringify(novo, null, 2));
  disco.renameSync(arquivo + '.tmp', arquivo);
  return { ok: true, n: ck.length };
}

module.exports = { ehSemSessao, cookiesDaCakto, renovarDoChrome, ARQUIVO };
