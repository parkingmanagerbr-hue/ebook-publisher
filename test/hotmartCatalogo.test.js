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
  // 3 pedidos: so a pagina VAZIA encerra (pagina curta no meio nao e o fim)
  assert.strictEqual(urls.length, 3);
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

test('listagem inteira com 500: le estado por estado e junta sem repetir id (07/10/2026)', async () => {
  const { baixarCatalogo, ESTADOS_DO_CATALOGO } = require('../src/agents/hotmartCatalogo');
  const pedidos = [];
  const fetchImpl = async (url) => {
    pedidos.push(url);
    const status = (url.match(/status=([A-Z_]+)/) || [])[1];
    if (!status) return { ok: false, status: 500, json: async () => ({}) };
    if (!/page=1&/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    const dados = { ACTIVE: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], PAUSED: [{ id: 3, name: 'C' }], DRAFT: [{ id: 2, name: 'B' }] }[status] || [];
    return { ok: true, status: 200, json: async () => ({ data: dados }) };
  };
  const avisos = [];
  const cat = await baixarCatalogo('t', { fetchImpl, avisar: m => avisos.push(m) });
  assert.deepStrictEqual(cat.map(p => p.id).sort(), [1, 2, 3]);
  const consultados = new Set(pedidos.map(u => (u.match(/status=([A-Z_]+)/) || [])[1]).filter(Boolean));
  assert.deepStrictEqual([...consultados].sort(), [...ESTADOS_DO_CATALOGO].sort());
  assert.match(avisos[0], /500/);
});

test('estado que falha derruba a leitura (catalogo pela metade deixaria passar duplicata)', async () => {
  const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');
  const fetchImpl = async (url) => {
    if (!/status=/.test(url) || /status=PAUSED/.test(url)) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  await assert.rejects(baixarCatalogo('t', { fetchImpl }), /PAUSED/);
});

test('erro 4xx na listagem inteira NAO vira leitura por estado (token vencido e outra coisa)', async () => {
  const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');
  let porEstado = 0;
  const fetchImpl = async (url) => { if (/status=/.test(url)) porEstado++; return { ok: false, status: 401, json: async () => ({}) }; };
  await assert.rejects(baixarCatalogo('t', { fetchImpl }), /401/);
  assert.strictEqual(porEstado, 0);
});

test('pagina do meio com MENOS itens nao encerra a leitura; so a vazia encerra', async () => {
  const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');
  const paginas = { 1: [1, 2, 3], 2: [4, 5], 3: [6, 7, 8], 4: [] };
  const fetchImpl = async (url) => {
    const p = Number(url.match(/page=(\d+)/)[1]);
    return { ok: true, status: 200, json: async () => ({ data: (paginas[p] || []).map(id => ({ id })) }) };
  };
  const cat = await baixarCatalogo('t', { fetchImpl, porPagina: 3 });
  assert.deepStrictEqual(cat.map(p => p.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('catalogo por titulos: busca cada titulo pelo nome, junta sem repetir, e falha se um titulo falhar', async () => {
  const { catalogoPorTitulos, idsPorTitulo } = require('../src/agents/hotmartCatalogo');
  const buscados = [];
  const fetchImpl = async (url) => {
    const nome = decodeURIComponent((url.match(/name=([^&]+)/) || [])[1] || '');
    const pagina = Number(url.match(/page=(\d+)/)[1]);
    if (pagina === 1) buscados.push(nome);
    const dados = pagina === 1 ? ({ 'Livro A': [{ id: 1, name: 'Livro A' }, { id: 9, name: 'Livro A: segunda parte' }], 'Livro B': [{ id: 1, name: 'Livro A' }] }[nome] || []) : [];
    return { ok: true, status: 200, json: async () => ({ data: dados }) };
  };
  const cat = await catalogoPorTitulos('t', ['Livro A', 'Livro B', 'Livro A', ''], { fetchImpl });
  assert.deepStrictEqual(buscados, ['Livro A', 'Livro B'], 'titulo repetido e vazio nao viram busca');
  assert.deepStrictEqual(cat.map(p => p.id).sort(), [1, 9]);
  // a busca casa trecho; o titulo IGUAL e so o produto 1 ('segunda parte' e outro livro)
  assert.deepStrictEqual(idsPorTitulo(cat, 'Livro A'), ['1']);
  await assert.rejects(catalogoPorTitulos('t', ['X'], { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), /500/);
});

test('catalogoPorTitulos sem titulos (ou so nulos) nao consulta nada', async () => {
  const { catalogoPorTitulos } = require('../src/agents/hotmartCatalogo');
  let chamadas = 0;
  const fetchImpl = async () => { chamadas++; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  assert.deepStrictEqual(await catalogoPorTitulos('t', undefined, { fetchImpl }), []);
  assert.deepStrictEqual(await catalogoPorTitulos('t', [null, undefined, '  '], { fetchImpl }), []);
  assert.strictEqual(chamadas, 0);
});
