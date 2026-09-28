'use strict';
/**
 * indexNow.js — avisa os buscadores que ha paginas novas, sem depender de
 * conta nem de credencial do dono.
 *
 * Contexto (28/09/2026): a vitrine passou de 23 para 3.457 paginas. Sitemap no
 * robots.txt e o caminho padrao, mas ele so ajuda quando o robo resolve
 * passar. O IndexNow e um protocolo aberto (Bing, Yandex, Seznam, Naver): o
 * site hospeda um arquivo com uma chave e avisa as URLs por HTTP.
 *
 * O Google NAO participa do IndexNow e aposentou o ping de sitemap em 2023 —
 * la a submissao explicita exige o Search Console, que e login do dono. Por
 * isso este agente nunca promete "indexado no Google": ele avisa quem aceita
 * ser avisado, e o resto depende de rastreio.
 *
 * Tudo aqui e puro; quem fala com a rede e o script.
 */

/** Chave do IndexNow: 8 a 128 caracteres hexadecimais. Pura. */
function chaveValida(chave) {
  return /^[a-f0-9]{8,128}$/i.test(String(chave == null ? '' : chave));
}

/** O arquivo que precisa ficar publico na raiz do site. Pura. */
function arquivoDaChave(chave) {
  return chaveValida(chave) ? { nome: String(chave) + '.txt', conteudo: String(chave) } : null;
}

/**
 * URLs que podem ser enviadas: so as do proprio host, sem repetir, no maximo
 * 10.000 por pedido (limite do protocolo).
 *
 * Mandar URL de outro dominio faz o pedido inteiro ser recusado. Pura.
 */
function urlsParaEnviar(urls, host, maximo = 10000) {
  const limpo = String(host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!limpo) return [];
  const vistas = new Set();
  const out = [];
  for (const u of (urls || [])) {
    const url = String(u == null ? '' : u).trim();
    if (!/^https:\/\//i.test(url)) continue;
    let dominio;
    try { dominio = new URL(url).host.toLowerCase(); } catch (_) { continue; }
    if (dominio !== limpo) continue;
    if (vistas.has(url)) continue;
    vistas.add(url);
    out.push(url);
    if (out.length >= Math.max(1, Math.min(10000, Number(maximo) || 10000))) break;
  }
  return out;
}

/** Corpo do pedido, como o protocolo define. Pura. */
function corpoDoPedido({ host, chave, urls }) {
  const lista = urlsParaEnviar(urls, host);
  if (!chaveValida(chave) || !lista.length) return null;
  const limpo = String(host).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    host: limpo,
    key: String(chave),
    keyLocation: 'https://' + limpo + '/' + chave + '.txt',
    urlList: lista,
  };
}

/**
 * O que a resposta significa. O protocolo usa o codigo HTTP como recado, e
 * 202 ("aceito, chave em verificacao") tambem e sucesso. Pura.
 */
function lerResposta(status) {
  const n = Number(status);
  if (n === 200 || n === 202) return { ok: true, motivo: n === 202 ? 'aceito, chave em verificacao' : 'aceito' };
  if (n === 400) return { ok: false, motivo: 'pedido malformado' };
  if (n === 403) return { ok: false, motivo: 'chave nao confere com o arquivo publicado' };
  if (n === 422) return { ok: false, motivo: 'URL fora do host declarado' };
  if (n === 429) return { ok: false, motivo: 'ritmo demais — tentar mais tarde' };
  // `Number(null)` e 0, que e finito: sem esta guarda, "sem resposta" vira
  // "resposta inesperada: 0" e o diagnostico aponta para o lado errado.
  const conhecido = status != null && status !== '' && Number.isFinite(n);
  return { ok: false, motivo: 'resposta inesperada: ' + (conhecido ? n : '?') };
}

module.exports = { chaveValida, arquivoDaChave, urlsParaEnviar, corpoDoPedido, lerResposta };
