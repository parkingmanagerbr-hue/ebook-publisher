'use strict';
/**
 * 02/10/2026: o /4/info da Hotmart termina de montar depois do preenchimento e
 * apaga nome e descricao; sem nome o produto nao nasce e o lote parava.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { garantirNomeEDescricao } = require('../src/agents/publisherHotmart');

function paginaFalsa(vazio) {
  const preenchidos = [];
  return {
    preenchidos,
    evaluate: async (_fn, seletor, valor) => {
      if (seletor === undefined) return vazio;
      preenchidos.push({ campo: /textarea/.test(seletor) ? 'descricao' : 'nome', valor });
      return true;
    },
  };
}

test('campo apagado pelo wizard e preenchido de novo com o valor certo', async () => {
  const p = paginaFalsa({ nome: true, descricao: true });
  const r = await garantirNomeEDescricao(p, 'Meu Livro', 'Uma descricao');
  assert.deepStrictEqual(r, { nome: true, descricao: true });
  assert.deepStrictEqual(p.preenchidos, [{ campo: 'nome', valor: 'Meu Livro' }, { campo: 'descricao', valor: 'Uma descricao' }]);
});

test('so o campo vazio e refeito; campo cheio nao e tocado', async () => {
  const p = paginaFalsa({ nome: false, descricao: true });
  await garantirNomeEDescricao(p, 'Meu Livro', 'Uma descricao');
  assert.deepStrictEqual(p.preenchidos.map((x) => x.campo), ['descricao']);
  const q = paginaFalsa({ nome: false, descricao: false });
  await garantirNomeEDescricao(q, 'Meu Livro', 'Uma descricao');
  assert.strictEqual(q.preenchidos.length, 0);
});

test('leitura que falha nao preenche as cegas', async () => {
  const p = { preenchidos: [], evaluate: async () => { throw new Error('frame detached'); } };
  assert.deepStrictEqual(await garantirNomeEDescricao(p, 'x', 'y'), { nome: false, descricao: false });
});
