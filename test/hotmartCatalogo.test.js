'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/agents/hotmartCatalogo');

const info = (o = {}) => ({ destaques: new Set(), noBanco: new Set(), vendas: new Map(), semArquivo: new Set(), ...o });
const P = (id, name, extra = {}) => ({ id, name, status: 'ACTIVE', creationDate: id, deleted: false, ...extra });

test('normalizar junta caixa, espacos e largura', () => {
  assert.strictEqual(c.normalizar('  Fundo  de\tEmergência '), 'fundo de emergência');
  assert.strictEqual(c.normalizar('ＡＢＣ'), 'abc');
  assert.strictEqual(c.normalizar(null), '');
});

test('agrupar ignora excluidos, sem titulo e unicos', () => {
  const g = c.agruparDuplicados([P(1, 'A'), P(2, 'a '), P(3, 'B'), P(4, 'B', { deleted: true }), P(5, ''), null]);
  assert.deepStrictEqual(g.map(x => x.map(p => p.id)), [[1, 2]]);
  assert.deepStrictEqual(c.agruparDuplicados(undefined), []);
});

test('ordem: arquivo, destaque, banco, venda, ativo, mais antigo', () => {
  const g = [P(1, 'x'), P(2, 'x'), P(3, 'x'), P(4, 'x'), P(5, 'x', { status: 'PAUSED' }), P(6, 'x'), P(7, 'x', { creationDate: undefined })];
  const ordem = c.ordenarGrupo(g, info({
    semArquivo: new Set(['4']), destaques: new Set(['3', '4']), noBanco: new Set(['2']), vendas: new Map([['6', 2]]),
  })).map(p => p.id);
  assert.deepStrictEqual(ordem, [3, 2, 6, 7, 1, 5, 4]);
});

test('decidir: fica o primeiro com arquivo confirmado; sem confirmacao nao decide', async () => {
  const g = [P(1, 'x'), P(2, 'x'), P(3, 'x')];
  const r = await c.decidirGrupo(g, info({ noBanco: new Set(['2']) }), async id => (id === '2' ? null : id === '3'));
  assert.deepStrictEqual(r, { fica: '3', copias: ['2', '1'] });
  assert.strictEqual(await c.decidirGrupo(g, info(), async () => null), null);
});

test('aplicarCanonico troca so as copias', () => {
  const r = c.aplicarCanonico([{ produtoId: '9', x: 1 }, { produtoId: 8 }], new Map([['9', '1']]));
  assert.deepStrictEqual(r, [{ produtoId: '1', x: 1, produtoOriginal: '9' }, { produtoId: 8, produtoOriginal: null }]);
});

test('idsPorTitulo acha existentes, mais antigo primeiro', () => {
  const cat = [P(5, 'Livro'), P(2, 'livro'), P(3, 'Livro', { deleted: true }), null, P(1, 'Outro')];
  assert.deepStrictEqual(c.idsPorTitulo(cat, ' LIVRO '), ['2', '5']);
  assert.deepStrictEqual(c.idsPorTitulo(cat, ''), []);
  assert.deepStrictEqual(c.idsPorTitulo(undefined, 'x'), []);
  assert.deepStrictEqual(c.idsPorTitulo([{ id: 1, name: 'x' }, { id: 2, name: 'x', creationDate: 0 }], 'x'), ['1', '2']);
});

test('baixarCatalogo pagina ate a ultima e falha com HTTP de erro', async () => {
  const urls = [];
  const paginas = { 1: [P(1, 'a'), P(2, 'b')], 2: [P(3, 'c')] };
  const fetchImpl = async (u, o) => {
    urls.push(u);
    assert.strictEqual(o.headers.authorization, 'Bearer T');
    const p = Number(new URL(u).searchParams.get('page'));
    return { ok: true, json: async () => ({ data: paginas[p] }) };
  };
  const todos = await c.baixarCatalogo('T', { fetchImpl, porPagina: 2 });
  assert.deepStrictEqual(todos.map(p => p.id), [1, 2, 3]);
  assert.strictEqual(urls.length, 2);
  const vazio = await c.baixarCatalogo('T', { fetchImpl: async () => ({ ok: true, json: async () => null }) });
  assert.deepStrictEqual(vazio, []);
  const limitado = await c.baixarCatalogo('T', { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [P(1, 'a')] }) }), porPagina: 1, maxPaginas: 2 });
  assert.strictEqual(limitado.length, 2);
  await assert.rejects(c.baixarCatalogo('T', { fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401 na pagina 1/);
});

test('baixarCatalogo usa fetch global por padrao', async () => {
  const antigo = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  try { assert.deepStrictEqual(await c.baixarCatalogo('T'), []); } finally { global.fetch = antigo; }
});

test('ordem com datas ausentes dos dois lados', () => {
  const sem = { id: 8, name: 'x', status: 'ACTIVE' };
  const com = P(9, 'x');
  assert.deepStrictEqual(c.ordenarGrupo([com, sem], info()).map(p => p.id), [8, 9]);
  assert.deepStrictEqual(c.ordenarGrupo([sem, com], info()).map(p => p.id), [8, 9]);
});
