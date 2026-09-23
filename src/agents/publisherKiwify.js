'use strict';
/**
 * publisherKiwify.js — publica e-book na Kiwify.
 *
 * Por que assim (medido em 22/09/2026, ver docs/kiwify.md): a API do painel
 * (`admin-api.kiwify.com.br`) exige DOIS segredos juntos — `authorization:
 * Bearer <idToken do Firebase>` e `kiwi-device-token`. Sem o segundo ela
 * responde `400 DEVICE_TOKEN_INVALID`, e o CORS nao aceita cookie. Por isso o
 * robo nao guarda credencial: ele roda de dentro da aba logada (Chrome com
 * porta de depuracao), pega o Bearer de uma requisicao real do proprio painel,
 * le o device token do localStorage e dispara os pedidos dali — mesma
 * estrategia ja usada na Hotmart.
 *
 * Ele nao preenche cadastro, documento nem dado bancario: a conta so recebe
 * quando o titular completa isso no painel.
 */
const { corpoDeCriacao, corpoDeAtualizacao, categoriaKiwify, mesmoProdutoKiwify, motivoRecusa, ehLimiteDeTaxa, esperaPorTentativa } = require('./kiwifyRegras');

let log;
try { log = require('../core/logger').createLogger('kiwify'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const API = 'https://admin-api.kiwify.com.br';
const PAINEL = 'https://dashboard.kiwify.com';
const dormir = ms => new Promise(r => setTimeout(r, ms));
/** valor que veio de fora nunca entra inteiro nem com quebra de linha no log */
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Abre a aba do painel e devolve as credenciais da sessao (nunca saem daqui). */
async function credenciais(page, { espera = 14000 } = {}) {
  let bearer = null;
  const ouvir = r => {
    const h = r.headers() || {};
    if (/admin-api\.kiwify/.test(r.url()) && h.authorization) bearer = h.authorization;
  };
  page.on('request', ouvir);
  await page.goto(PAINEL + '/products', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await dormir(espera);
  page.off('request', ouvir);
  const device = await page.evaluate(() => {
    const k = Object.keys(localStorage).find(x => x.startsWith('kiwi_device_token_'));
    return k ? localStorage.getItem(k) : null;
  }).catch(() => null);
  if (!bearer || !device) {
    throw new Error('KIWIFY_SEM_SESSAO: abra o painel da Kiwify logado na aba (bearer=' + !!bearer + ' device=' + !!device + ')');
  }
  return { bearer, device };
}

/**
 * Uma chamada a API, feita de dentro da pagina (o navegador resolve CORS e TLS).
 * Em 429 espera e tenta de novo: a Kiwify limita o ritmo e sem isso o lote
 * inteiro vira falha em segundos (medido em 23/09/2026: 57 de 60).
 */
async function chamar(page, cred, metodo, caminho, corpo, { tentativas = 3, esperar = dormir } = {}) {
  let r = await chamarUmaVez(page, cred, metodo, caminho, corpo);
  for (let n = 1; n < tentativas && ehLimiteDeTaxa(r.status, r.texto); n++) {
    const espera = esperaPorTentativa(n);
    log.warn('limite de ritmo da Kiwify em ' + umaLinha(caminho, 60) + ' — esperando ' + Math.round(espera / 1000) + 's (tentativa ' + n + ')');
    await esperar(espera);
    r = await chamarUmaVez(page, cred, metodo, caminho, corpo);
  }
  return r;
}

async function chamarUmaVez(page, cred, metodo, caminho, corpo) {
  const r = await page.evaluate(async (api, auth, dev, m, c, body) => {
    try {
      const resp = await fetch(api + c, {
        method: m,
        headers: { authorization: auth, 'kiwi-device-token': dev, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const texto = await resp.text();
      return { status: resp.status, texto: texto.slice(0, 4000) };
    } catch (e) { return { status: 0, texto: String(e).slice(0, 200) }; }
  }, API, cred.bearer, cred.device, metodo, caminho, corpo || null);
  let json = null;
  try { json = JSON.parse(r.texto); } catch (_) {}
  return { status: r.status, json, texto: r.texto };
}

/** Produtos que ja existem na conta, por nome normalizado (evita duplicar). */
async function catalogo(page, cred, opcoes) {
  const r = await chamar(page, cred, 'GET', '/v1/products', null, opcoes);
  const lista = Array.isArray(r.json) ? r.json : (r.json && (r.json.data || r.json.products)) || [];
  const porNome = new Map();
  for (const p of lista) {
    if (!p || !p.name) continue;
    porNome.set(String(p.name).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), p.id);
  }
  return { total: lista.length, porNome };
}

/**
 * Publica um livro. Devolve { id, url, jaExistia } ou lanca.
 * `livro`: { title, description, language, preco, paginaDeVendas, topic }
 */
async function publicarNaKiwify(page, livro, { cred, espera, opcoesDeChamada } = {}) {
  const credenciais_ = cred || await credenciais(page, { espera });
  const titulo = String(livro.title || '').trim();
  if (!titulo) throw new Error('KIWIFY_SEM_TITULO: livro sem nome');

  const { porNome, total } = await catalogo(page, credenciais_, opcoesDeChamada);
  const chave = titulo.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (porNome.has(chave)) {
    const id = porNome.get(chave);
    log.info('ja estava na Kiwify: "' + umaLinha(titulo) + '" id=' + umaLinha(id, 40) + ' (catalogo com ' + total + ')');
    return { id, url: PAINEL + '/products/edit/' + id, jaExistia: true };
  }

  const corpo = corpoDeCriacao(livro);
  const criado = await chamar(page, credenciais_, 'POST', '/v1/products', corpo, opcoesDeChamada);
  if (criado.status !== 200 && criado.status !== 201) {
    const recusa = motivoRecusa(criado.texto);
    if (recusa) {
      // Recusa de conteudo nao se resolve tentando de novo: sai da fila.
      log.warn('recusado pelo filtro da Kiwify: "' + umaLinha(titulo) + '" palavra=' + umaLinha(recusa, 40));
      throw new Error('KIWIFY_RECUSADO: ' + umaLinha(recusa, 40));
    }
    throw new Error('KIWIFY_CRIACAO_FALHOU: status ' + criado.status + ' ' + umaLinha(criado.texto, 120));
  }
  const id = criado.json && (criado.json.id || (criado.json.product && criado.json.product.id));
  if (!id) throw new Error('KIWIFY_SEM_ID: a API aceitou mas nao devolveu id — ' + umaLinha(criado.texto, 120));
  log.info('criado id=' + umaLinha(id, 40) + ' "' + umaLinha(titulo) + '" ' + corpo.currency + ' ' + corpo.price + ' centavos');

  // Categoria e ajustes de checkout: a Kiwify so aceita o objeto inteiro (nao ha PATCH).
  // ?full=true: sem isso o GET nao devolve categoria, approved_url nem garantia.
  const atual = await chamar(page, credenciais_, 'GET', '/v1/products/' + id + '?full=true', null, opcoesDeChamada);
  const base = (atual.json && (atual.json.product || atual.json)) || {};
  if (!mesmoProdutoKiwify(base.name, titulo)) {
    log.error('PRODUTO_ERRADO na Kiwify: id ' + umaLinha(id, 40) + ' e "' + umaLinha(base.name) + '", nao "' + umaLinha(titulo) + '" — nada alterado');
    throw new Error('KIWIFY_PRODUTO_ERRADO: ' + umaLinha(id, 40));
  }
  const categoria = categoriaKiwify(titulo, livro.topic);
  const atualizado = await chamar(page, credenciais_, 'PUT', '/v1/products/' + id, corpoDeAtualizacao(base, livro, categoria), opcoesDeChamada);
  if (atualizado.status >= 400) {
    log.warn('produto criado mas categoria nao entrou: id=' + umaLinha(id, 40) + ' status=' + atualizado.status + ' ' + umaLinha(atualizado.texto, 160));
  } else {
    log.info('categoria ' + categoria + ' gravada em id=' + umaLinha(id, 40));
  }
  return { id, url: PAINEL + '/products/edit/' + id, jaExistia: false, categoria };
}

module.exports = { publicarNaKiwify, credenciais, chamar, catalogo, API, PAINEL };
