'use strict';
/**
 * Checkout da Cakto na vitrine: so produto ATIVO (pausado mostra "Produto nao
 * encontrado"), conferido na lista da propria Cakto — e lista pela metade nunca
 * autoriza limpar o link de ninguem.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const C = require('../src/agents/caktoCheckout');
const { lojasDoLivro, linkDeCompra } = require('../src/agents/vitrineRegras');
const script = require('../scripts/caktoCheckoutDoCatalogo');

const ofertas = [
  { id: 'ok3iche', product: 'p-ativo', status: 'active' },
  { id: 'pausad1', product: 'p-pausado', status: 'active' },
  { id: 'ofinat1', product: 'p-ativo2', status: 'disabled' },
  { id: 'semprod', product: 'p-sumiu', status: 'active' },
  { id: 'x', product: 'p-ativo', status: 'active' },
];
const produtos = [
  { id: 'p-ativo', status: 'active' }, { id: 'p-pausado', status: 'waiting_config' },
  { id: 'p-ativo2', status: 'active' }, { id: 'p-orfao', status: 'active' },
];
const mapas = () => [new Map(ofertas.map(o => [o.id, o])), new Map(produtos.map(p => [p.id, p.status]))];

test('so oferta ativa de produto ativo vira link; cada outro caso diz por que', () => {
  const [o, p] = mapas();
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'ok3iche' }, o, p), { acao: 'gravar', url: 'https://pay.cakto.com.br/ok3iche' });
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'pausad1' }, o, p), { acao: 'limpar', motivo: 'produto-waiting_config' }, 'pausado mostra "Produto nao encontrado"');
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'ofinat1' }, o, p), { acao: 'limpar', motivo: 'oferta-inativa' });
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'semprod' }, o, p), { acao: 'limpar', motivo: 'produto-ausente' });
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'naoexiste' }, o, p), { acao: 'limpar', motivo: 'sem-oferta' }, 'id do livro divergente da Cakto');
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'x' }, o, p), { acao: 'limpar', motivo: 'shortcode-invalido' });
  assert.deepStrictEqual(C.decidirCheckout(null, o, p), { acao: 'limpar', motivo: 'sem-oferta' });
  assert.strictEqual(C.urlDoCheckout(' ok3iche '), 'https://pay.cakto.com.br/ok3iche');
  assert.strictEqual(C.urlDoCheckout('a/b'), null);
  assert.strictEqual(C.urlDoCheckout(null), null);
});

test('plano: grava o ativo, limpa o resto, so muda o que difere, e conta os ativos sem livro', () => {
  const livros = [
    { id: 'L1', cakto_product_id: 'ok3iche', cakto_checkout: null },
    { id: 'L2', cakto_product_id: 'pausad1', cakto_checkout: 'https://pay.cakto.com.br/pausad1' },
    { id: 'L3', cakto_product_id: 'ok3iche', cakto_checkout: 'https://pay.cakto.com.br/ok3iche' },
    { id: 'L4', cakto_product_id: 'naoexiste' },
  ];
  const { mudancas, resumo } = C.planejar(livros, ofertas, produtos);
  assert.deepStrictEqual(mudancas, [{ id: 'L1', para: 'https://pay.cakto.com.br/ok3iche' }, { id: 'L2', para: null }]);
  assert.deepStrictEqual(resumo, { livros: 4, ativos: 2, motivos: { 'produto-waiting_config': 1, 'sem-oferta': 1 }, produtosAtivosSemLivro: 2, mudancas: 2 });
  assert.deepStrictEqual(C.planejar(null, null, null).resumo, { livros: 0, ativos: 0, motivos: {}, produtosAtivosSemLivro: 0, mudancas: 0 });
});

function pedidoFalso(paginas, { quebraEm } = {}) {
  const pedidos = [];
  return {
    pedidos,
    pedir: async rota => {
      pedidos.push(rota);
      const n = Number(/page=(\d+)/.exec(rota)[1]);
      if (quebraEm === n) return { status: 503, json: null };
      if (n > paginas.length) return { status: 404, json: { detail: 'Página inválida.' } };
      return { status: 200, json: { count: paginas.flat().length, next: n < paginas.length + (paginas.sem_next ? 0 : 1), results: paginas[n - 1] } };
    },
  };
}

test('paginacao termina no 404 "Pagina invalida", com espera entre as chamadas', async () => {
  const f = pedidoFalso([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  let esperas = 0;
  const r = await C.lerPaginado('offers/', { pedir: f.pedir, esperar: async () => { esperas++; }, porPagina: 2 });
  assert.deepStrictEqual(r.itens.map(x => x.id), [1, 2, 3]);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(f.pedidos, ['offers/?limit=2&page=1', 'offers/?limit=2&page=2', 'offers/?limit=2&page=3']);
  assert.strictEqual(esperas, 2, 'nunca duas chamadas seguidas sem pausa (Cloudflare)');
  const semNext = await C.lerPaginado('p/', { pedir: async () => ({ status: 200, json: { count: 1, next: null, results: [{ id: 9 }] } }), esperar: async () => {} });
  assert.deepStrictEqual(semNext.itens.map(x => x.id), [9], 'sem "next" tambem termina');
});

test('erro no meio da lista LANCA: lista pela metade nao vira "o resto nao existe"', async () => {
  const f = pedidoFalso([[{ id: 1 }], [{ id: 2 }]], { quebraEm: 2 });
  await assert.rejects(() => C.lerPaginado('products/', { pedir: f.pedir, esperar: async () => {} }), /CAKTO_LISTA_FALHOU: products\/ pagina 2 HTTP 503/);
  await assert.rejects(() => C.lerPaginado('p/', { pedir: async () => ({ status: 200, json: { results: 'x' } }), esperar: async () => {} }), /CAKTO_LISTA_FALHOU/);
  await assert.rejects(() => C.lerPaginado('p/', { pedir: async () => ({ status: 200, json: { count: 9, next: 'sim', results: [] } }), esperar: async () => {}, tetoPaginas: 3 }), /CAKTO_LISTA_SEM_FIM/);
});

test('lista completa exige 98% do total declarado', () => {
  assert.strictEqual(C.listaCompleta({ itens: new Array(98), total: 100 }), true);
  assert.strictEqual(C.listaCompleta({ itens: new Array(97), total: 100 }), false);
  assert.strictEqual(C.listaCompleta({ itens: [], total: null }), false, 'sem total declarado nao se confia');
  assert.strictEqual(C.listaCompleta(null), false);
});

test('vitrine: Cakto entra pelo cakto_checkout, e o formato antigo continua', () => {
  assert.deepStrictEqual(lojasDoLivro({ cakto_checkout: 'https://pay.cakto.com.br/ok3iche' }).map(x => x.url), ['https://pay.cakto.com.br/ok3iche']);
  assert.deepStrictEqual(lojasDoLivro({ cakto_checkout: 'https://pay.cakto.com.br/ok3iche/x' }), [], 'nada depois do shortcode');
  assert.deepStrictEqual(lojasDoLivro({ cakto_checkout: 'http://pay.cakto.com.br/ok3iche' }), []);
  assert.deepStrictEqual(lojasDoLivro({ cakto_product_id: 'ok3iche' }), [], 'shortcode sem conferencia de ativo nunca vira botao');
  assert.strictEqual(linkDeCompra({ cakto_sales_page: 'https://pay.cakto.com.br/abc123_1147168' }), 'https://pay.cakto.com.br/abc123_1147168');
});

test('script: grava com lista inteira, e com lista incompleta nao toca em nada', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, cakto_product_id TEXT)');
  db.prepare("INSERT INTO ebooks VALUES ('L1', 'ok3iche'), ('L2', 'pausad1'), ('L3', NULL)").run();
  const mundo = (totalProdutos) => async rota => {
    const n = Number(/page=(\d+)/.exec(rota)[1]);
    if (n > 1) return { status: 404, json: { detail: 'Página inválida.' } };
    if (rota.startsWith('products/')) return { status: 200, json: { count: totalProdutos, next: 'x', results: produtos } };
    return { status: 200, json: { count: ofertas.length, next: 'x', results: ofertas } };
  };
  const seco = await script.principal({ db, pedir: mundo(4), esperar: async () => {}, seco: true });
  assert.strictEqual(seco.gravado, false);
  assert.strictEqual(db.prepare("SELECT cakto_checkout c FROM ebooks WHERE id = 'L1'").get().c, null, 'dry-run nao grava');
  const r = await script.principal({ db, pedir: mundo(4), esperar: async () => {}, seco: false });
  assert.strictEqual(r.gravado, true);
  assert.strictEqual(r.ativos, 1);
  assert.deepStrictEqual(r.produtosPorStatus, { active: 3, waiting_config: 1 });
  assert.strictEqual(db.prepare("SELECT cakto_checkout c FROM ebooks WHERE id = 'L1'").get().c, 'https://pay.cakto.com.br/ok3iche');
  assert.strictEqual(db.prepare("SELECT cakto_checkout c FROM ebooks WHERE id = 'L2'").get().c, null);
  db.prepare("UPDATE ebooks SET cakto_checkout = 'https://pay.cakto.com.br/ok3iche' WHERE id = 'L1'").run();
  const parcial = await script.principal({ db, pedir: mundo(400), esperar: async () => {}, seco: false });
  assert.deepStrictEqual(parcial, { gravado: false, motivo: 'lista-incompleta' });
  assert.strictEqual(db.prepare("SELECT cakto_checkout c FROM ebooks WHERE id = 'L1'").get().c, 'https://pay.cakto.com.br/ok3iche', 'lista curta nao limpa o link de ninguem');
});

test('bordas: oferta sem produto e livro sem id', () => {
  const o = new Map([['semp001', { id: 'semp001', status: 'active' }]]);
  assert.deepStrictEqual(C.decidirCheckout({ cakto_product_id: 'semp001' }, o, new Map()), { acao: 'limpar', motivo: 'produto-ausente' });
  assert.deepStrictEqual(C.planejar([{ id: 'L9' }], [], []).resumo.motivos, { 'sem-oferta': 1 });
});

test('429 no meio: espera cada vez mais e repete a MESMA pagina; insistente, lanca', async () => {
  let vezes = 0;
  const pedidos = [];
  const pedir = async rota => {
    pedidos.push(rota);
    const n = Number(/page=(\d+)/.exec(rota)[1]);
    if (n === 2 && vezes++ < 2) return { status: 429, json: null };
    if (n > 2) return { status: 404, json: {} };
    return { status: 200, json: { count: 2, next: 'x', results: [{ id: n }] } };
  };
  const niveis = [];
  const r = await C.lerPaginado('products/', { pedir, esperar: async nivel => { niveis.push(nivel); } });
  assert.deepStrictEqual(r.itens.map(x => x.id), [1, 2], 'nenhuma pagina perdida');
  assert.deepStrictEqual(pedidos.filter(p => /page=2/.test(p)).length, 3, 'a pagina 2 foi pedida de novo');
  assert.deepStrictEqual(niveis, [0, 1, 2, 0], 'ritmo normal, depois espera crescente, depois normal');
  const sempre = async () => ({ status: 429, json: null });
  await assert.rejects(() => C.lerPaginado('offers/', { pedir: sempre, esperar: async () => {}, tentativas429: 3 }), /CAKTO_LISTA_FALHOU: offers\/ pagina 1 HTTP 429/);
});
