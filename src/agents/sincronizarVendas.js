'use strict';
/**
 * sincronizarVendas.js — traz as vendas do Hotmart para o banco.
 *
 * POR QUE EXISTE: em 14/09/2026 o Hotmart mostrava 4 vendas aprovadas no dia
 * enquanto o learningAgent registrava "0 vendas, R$ 0,00" nos 8.614 e-books.
 * Nada trazia a venda para cá. Sem ela, o bandit das capas (scoreCoverHooks)
 * pontuava toda tecnica com zero para sempre, e "aprender o que vende" era um
 * sorteio com passos extras.
 *
 * O QUE GRAVA: so dados do produto e da transacao. Nome, e-mail e documento do
 * comprador vem na resposta da API e ficam de fora de proposito — para saber o
 * que vende nao sao necessarios, e dado pessoal de cliente nao deve ir parar em
 * banco de automacao.
 *
 * PRODUTO ORFAO: produto que vende e nao existe na tabela ebooks. Aconteceu com
 * copias publicadas a mao em teste — o e-book japones vendeu duas vezes sem que
 * o sistema soubesse que ele existia. O relatorio lista os orfaos.
 *
 * Token: /app/data/hotmart_access_token.txt, renovado pelo vigia local
 * (scripts/manter_capas.ps1). A API de relatorio aceita esse Bearer do servidor.
 *
 * Uso: node src/agents/sincronizarVendas.js
 */
const fs = require('fs');
const path = require('path');
const { aplicarCanonico } = require('./hotmartCatalogo');

let log;
try { log = require('../core/logger').createLogger('sincronizarVendas'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const TOKEN_FILE = process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt';
const BASE = 'https://api-report.hotmart.com/rest/v2/sales/history';
const JANELA_DIAS = parseInt(process.env.VENDAS_JANELA_DIAS || '365', 10);

/** Reduz uma venda da API ao que interessa, SEM dados do comprador. */
function extrairVenda(v) {
  const compra = (v && v.purchase) || {};
  const produto = (v && v.product) || {};
  const oferta = (v && v.offer) || {};
  if (!compra.transaction || !produto.id) return null;
  return {
    transacao: String(compra.transaction),
    produtoId: String(produto.id),
    produto: String(produto.name || ''),
    quando: Number(compra.orderDate) || 0,
    preco: Number((oferta.price && oferta.price.value) || 0),
    comissao: Number((v.commission && v.commission.value) || 0),
    status: String(compra.status || ''),
  };
}

/**
 * Marca vendas de RAJADA como suspeitas (teste de cartao roubado).
 *
 * Em 15/09/2026 o "aprendizado com as vendas" estava sendo alimentado por um
 * robo: compras de produtos diferentes a 1, 3, 7 e 12 s uma da outra, de
 * madrugada, e 263 tentativas canceladas no mesmo padrao (mediana de 4 s entre
 * tentativas, cada uma num produto). Leitor nao compra 65 e-books por hora.
 * Aprender com isso ensinou "japones vende".
 *
 * Regra: vendas separadas por ate JANELA_MIN formam um grupo; grupo com
 * MIN_PRODUTOS ou mais produtos distintos e rajada. Venda isolada fica valendo.
 * Devolve novas vendas com `suspeita: true|false`, sem alterar a entrada.
 */
const RAJADA_JANELA_MIN = parseInt(process.env.RAJADA_JANELA_MIN || '15', 10);
const RAJADA_MIN_PRODUTOS = parseInt(process.env.RAJADA_MIN_PRODUTOS || '3', 10);

function marcarSuspeitas(vendas, janelaMin = RAJADA_JANELA_MIN, minProdutos = RAJADA_MIN_PRODUTOS) {
  const ordenadas = vendas.filter(Boolean).map(v => ({ ...v })).sort((a, b) => a.quando - b.quando);
  let grupo = [];
  const fechar = () => {
    const distintos = new Set(grupo.map(v => v.produtoId)).size;
    for (const v of grupo) v.suspeita = distintos >= minProdutos;
    grupo = [];
  };
  for (const v of ordenadas) {
    const ultimo = grupo[grupo.length - 1];
    if (ultimo && v.quando - ultimo.quando > janelaMin * 60000) fechar();
    grupo.push(v);
  }
  fechar();
  return ordenadas;
}

/**
 * Soma vendas e receita por produto. Receita = comissao (o que de fato entra
 * para o produtor), nao o preco de tabela.
 */
function agregarPorProduto(vendas) {
  const mapa = new Map();
  for (const v of vendas) {
    if (!v) continue;
    const a = mapa.get(v.produtoId) || { vendas: 0, receita: 0, produto: v.produto };
    a.vendas += 1;
    a.receita = Math.round((a.receita + v.comissao) * 100) / 100;
    mapa.set(v.produtoId, a);
  }
  return mapa;
}

async function buscarVendas(token, agora = Date.now()) {
  const ini = agora - JANELA_DIAS * 86400000;
  const todas = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const url = BASE + '?rows=100&page=' + pagina + '&orderBy=REQUEST_DATE' +
      '&transactionStatus=APPROVED&transactionStatus=COMPLETE&statusType=TRANSACTION' +
      '&startDate=' + ini + '&endDate=' + agora;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('relatorio do Hotmart devolveu HTTP ' + r.status);
    const j = await r.json();
    const lote = (j && j.data) || [];
    for (const v of lote) { const x = extrairVenda(v); if (x) todas.push(x); }
    if (lote.length < 100) break;
  }
  return todas;
}

async function sincronizar() {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const brutas = marcarSuspeitas(await buscarVendas(token));

  const { getDb } = require('../core/database');
  const db = getDb();
  // Venda de copia duplicada conta no produto que ficou (ver hotmartCatalogo).
  let copias = new Map();
  try { copias = new Map(db.prepare('SELECT copia, canonico FROM hotmart_copias').all().map(r => [String(r.copia), String(r.canonico)])); } catch { /* tabela ainda nao existe */ }
  const vendas = aplicarCanonico(brutas, copias);
  db.prepare(
    'CREATE TABLE IF NOT EXISTS vendas_hotmart (' +
    'transacao TEXT PRIMARY KEY, produto_id TEXT NOT NULL, produto TEXT, quando INTEGER, ' +
    'preco REAL, comissao REAL, status TEXT, visto_em INTEGER NOT NULL)'
  ).run();
  try { db.prepare('ALTER TABLE vendas_hotmart ADD COLUMN suspeita INTEGER NOT NULL DEFAULT 0').run(); } catch { /* ja existe */ }
  try { db.prepare('ALTER TABLE vendas_hotmart ADD COLUMN produto_original TEXT').run(); } catch { /* ja existe */ }

  const ins = db.prepare(
    'INSERT INTO vendas_hotmart (transacao, produto_id, produto, quando, preco, comissao, status, visto_em, suspeita, produto_original) ' +
    'VALUES (@transacao, @produtoId, @produto, @quando, @preco, @comissao, @status, @vistoEm, @suspeitaNum, @produtoOriginal) ' +
    'ON CONFLICT(transacao) DO UPDATE SET produto_id = excluded.produto_id, status = excluded.status, visto_em = excluded.visto_em, ' +
    'suspeita = excluded.suspeita, produto_original = excluded.produto_original'
  );
  const agora = Date.now();
  db.transaction(lista => { for (const v of lista) ins.run({ ...v, vistoEm: agora, suspeitaNum: v.suspeita ? 1 : 0 }); })(vendas);

  // Contagem sai da lista ATUAL da API: venda reembolsada sai de APPROVED e,
  // recontando do zero, deixa de contar — em vez de ficar somada para sempre.
  // Venda de rajada fica gravada (para acompanhar estorno) mas nao conta: ela
  // e o que ensina o bandit e a escolha de idioma.
  const agg = agregarPorProduto(vendas.filter(v => !v.suspeita));
  const suspeitas = vendas.filter(v => v.suspeita).length;
  if (suspeitas) log.warn('vendas de rajada (suspeita de teste de cartao) fora do aprendizado: ' + suspeitas + ' de ' + vendas.length);
  const zera = db.prepare('UPDATE ebooks SET sales_count = 0, revenue = 0 WHERE hotmart_product_id IS NOT NULL');
  const poe = db.prepare('UPDATE ebooks SET sales_count = ?, revenue = ? WHERE hotmart_product_id = ?');
  const orfaos = [];
  db.transaction(() => {
    zera.run();
    for (const [pid, a] of agg) {
      const r = poe.run(a.vendas, a.receita, pid);
      if (r.changes === 0) orfaos.push({ produtoId: pid, produto: a.produto, vendas: a.vendas });
    }
  })();

  const receita = vendas.reduce((s, v) => s + v.comissao, 0);
  log.info('vendas sincronizadas: ' + vendas.length + ' | produtos com venda: ' + agg.size +
    ' | receita: R$ ' + receita.toFixed(2) + ' | orfaos: ' + orfaos.length);
  for (const o of orfaos) log.warn('ORFAO — vendeu e nao esta no banco: #' + o.produtoId + ' ' + o.produto.slice(0, 50) + ' (' + o.vendas + ')');
  return { vendas: vendas.length, suspeitas, produtos: agg.size, receita: Math.round(receita * 100) / 100, orfaos };
}

module.exports = { sincronizar, extrairVenda, agregarPorProduto, marcarSuspeitas };

if (require.main === module) {
  sincronizar()
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
}
