'use strict';
/**
 * Nenhum arquivo de codigo com byte de controle. Script gerador de codigo
 * transforma barra-b (limite de palavra) em backspace e barra-n em quebra de
 * linha real; o regex passa a nao casar nada, calado, e `node -c` nao acusa.
 * Em 06/10/2026 isso aconteceu QUATRO vezes numa sessao — a lição escrita nao
 * bastou, entao a suite vigia.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function arquivosJs(dir) {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosJs(p));
    else if (e.name.endsWith('.js')) saida.push(p);
  }
  return saida;
}

test('codigo sem byte de controle (barra-b virando backspace)', () => {
  const raiz = path.join(__dirname, '..');
  const arquivos = ['src', 'scripts', 'test'].flatMap(d => arquivosJs(path.join(raiz, d)));
  assert.ok(arquivos.length > 50, 'achou poucos arquivos: ' + arquivos.length);
  const ruins = [];
  for (const a of arquivos) {
    const s = fs.readFileSync(a, 'utf8');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 9 || c === 11 || c === 12 || (c >= 14 && c < 32)) { ruins.push(path.relative(raiz, a) + ':' + (s.slice(0, i).split('\n').length)); break; }
    }
  }
  assert.deepStrictEqual(ruins, []);
});
