'use strict';
/**
 * O gate de cobertura e o que impede a logica de negocio de perder teste em
 * silencio. Se ele ler o lcov errado, passa a aprovar tudo — e ninguem nota,
 * porque "verde" e exatamente o que se espera ver. Por isso cada regra tem o
 * lado que reprova.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lerLcov, resumir, avaliar, compactar, expandirModulos, formatarTabela, MODULOS_NO_GATE } = require('../scripts/gateCobertura');

const registro = (sf, corpo) => ['TN:', 'SF:' + sf, ...corpo, 'end_of_record'].join('\n');

test('arquivo 100% coberto passa; uma linha a zero reprova e aponta a linha', () => {
  const cheio = lerLcov(registro('a.js', ['FN:1,f', 'FNDA:2,f', 'BRDA:1,0,0,2', 'DA:1,2', 'DA:2,1']));
  assert.strictEqual(avaliar(['a.js'], cheio, () => '').at(0).ok, true);

  const furado = lerLcov(registro('a.js', ['FN:1,f', 'FNDA:2,f', 'DA:1,2', 'DA:2,0', 'DA:3,0']));
  const r = avaliar(['a.js'], furado, () => '')[0];
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.linhas, 33.33);
  assert.match(r.problemas.join(), /linhas sem cobertura: 2-3/);
});

test('funcao nunca chamada e ramo nunca tomado reprovam mesmo com linhas em 100%', () => {
  const lc = lerLcov(registro('b.js', ['FN:1,usada', 'FN:5,esquecida', 'FNDA:1,usada', 'FNDA:0,esquecida',
    'BRDA:3,0,0,1', 'BRDA:7,1,0,0', 'BRDA:7,1,1,-', 'DA:1,1']));
  const r = avaliar(['b.js'], lc, () => '')[0];
  assert.strictEqual(r.linhas, 100);
  assert.strictEqual(r.funcoes, 50);
  assert.match(r.problemas.join(), /esquecida/);
  assert.strictEqual(r.ramos, 33.33, 'o "-" do lcov (ramo nao executado) conta como zero');
  assert.match(r.problemas.join(), /ramos sem cobertura nas linhas: 7/);
});

test('modulo da lista que nenhum teste carregou conta como 0%, nao some', () => {
  const r = avaliar(['nunca.js'], new Map(), () => null)[0];
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.linhas, 0);
  assert.match(r.problemas[0], /nenhum teste carregou/);
});

test('trecho ignorado por comentario node:coverage reprova', () => {
  const lc = lerLcov(registro('c.js', ['DA:1,1']));
  assert.strictEqual(avaliar(['c.js'], lc, () => '/* node:coverage ignore next */')[0].ok, false);
  assert.strictEqual(avaliar(['c.js'], lc, () => 'const x = 1;')[0].ok, true);
});

test('registro repetido do mesmo arquivo SOMA (um processo nao apaga o que o outro cobriu)', () => {
  const texto = registro('d.js', ['FN:1,f', 'FNDA:0,f', 'DA:1,0', 'DA:2,3', 'BRDA:2,0,0,0']) + '\n' +
                registro('d.js', ['FN:1,f', 'FNDA:4,f', 'DA:1,5', 'DA:2,0', 'BRDA:2,0,0,1']);
  const r = resumir(lerLcov(texto).get('d.js'));
  assert.strictEqual(r.linhas, 100);
  assert.strictEqual(r.funcoes, 100);
  assert.strictEqual(r.ramos, 100);
});

test('funcoes de mesmo nome sao casadas por posicao, nao pelo nome', () => {
  // Duas "arg" no mesmo arquivo: casar por nome daria a contagem da primeira
  // para as duas e esconderia a segunda sem teste.
  const lc = lerLcov(registro('e.js', ['FN:3,arg', 'FN:9,arg', 'FNDA:7,arg', 'FNDA:0,arg']));
  const r = resumir(lc.get('e.js'));
  assert.strictEqual(r.funcoes, 50);
  assert.deepStrictEqual(r.funcoesZero, ['9,arg']);
});

test('caminho do lcov passa pela normalizacao (Windows escreve com barra invertida)', () => {
  const sep = String.fromCharCode(92);
  const lc = lerLcov(registro('src' + sep + 'x.js', ['DA:1,1']) + '\r\n', p => p.split(sep).join('/'));
  assert.ok(lc.has('src/x.js'));
});

test('linha fora de registro e ignorada; arquivo sem linha nem ramo vale 100%', () => {
  const lc = lerLcov('DA:1,0\nlixo\n' + registro('f.js', []));
  assert.strictEqual(lc.size, 1);
  const r = resumir(lc.get('f.js'));
  assert.deepStrictEqual([r.linhas, r.funcoes, r.ramos], [100, 100, 100]);
});

test('compactar agrupa intervalos e remove repeticao', () => {
  assert.strictEqual(compactar([9, 3, 4, 5, 5, 11, 12]), '3-5 9 11-12');
  assert.strictEqual(compactar([]), '');
});

test('expandirModulos: diretorio entra inteiro e recursivo; arquivo inexistente e erro', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    fs.mkdirSync(path.join(raiz, 'd', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(raiz, 'd', 'a.js'), '');
    fs.writeFileSync(path.join(raiz, 'd', 'sub', 'b.js'), '');
    fs.writeFileSync(path.join(raiz, 'd', 'nota.md'), '');
    fs.writeFileSync(path.join(raiz, 'solto.js'), '');
    assert.deepStrictEqual(expandirModulos(['d/', 'solto.js', 'd/a.js'], raiz), ['d/a.js', 'd/sub/b.js', 'solto.js']);
    assert.throws(() => expandirModulos(['sumiu.js'], raiz), /nao existe/);
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('a lista real do gate so aponta para arquivos que existem', () => {
  assert.ok(expandirModulos(MODULOS_NO_GATE).length > 0);
});

test('tabela marca a falha e lista o motivo embaixo', () => {
  const t = formatarTabela([
    { modulo: 'ok.js', linhas: 100, funcoes: 100, ramos: 100, problemas: [], ok: true },
    { modulo: 'ruim.js', linhas: 50, funcoes: 100, ramos: 100, problemas: ['linhas sem cobertura: 2'], ok: false },
  ]);
  assert.match(t, /ruim\.js .*FALHA\n {4}linhas sem cobertura: 2/);
  assert.doesNotMatch(t.split('\n').find(l => l.startsWith('ok.js')), /FALHA/);
});
