'use strict';
/**
 * gateCobertura.js — roda a suite e FALHA se a logica de negocio perder cobertura.
 *
 * Por que um script e nao as flags do Node: a imagem de producao e node:20 e o
 * Node 20.20 nao tem --test-coverage-lines/functions/branches nem
 * --test-coverage-include/exclude (so existem a partir do 22). O reporter lcov
 * existe nos dois, entao o gate le o lcov e decide sozinho — funciona igual no
 * 20 e no 22.
 *
 * Uso: node scripts/gateCobertura.js            (npm test)
 *      node scripts/gateCobertura.js --relatorio (mostra a tabela, nao falha pela cobertura)
 *
 * Regras do gate:
 *   - todo modulo da lista tem de ter 100% de linhas, funcoes e ramos;
 *   - modulo da lista que nenhum teste carregou conta como 0% (nao some do relatorio);
 *   - comentario "node:coverage" dentro de modulo do gate e recusado — 100% com
 *     trecho ignorado nao e 100%.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

// Diretorio (termina em "/") entra inteiro, recursivo. Arquivo novo que cair
// dentro dele entra no gate automaticamente — de proposito.
const MODULOS_NO_GATE = [
  'src/domain/',
  'src/application/commands/',
  'src/application/orchestrator/',
  'src/infrastructure/db/',
  'src/infrastructure/queue/',
  'src/core/retencao.js',
];

function listarJs(dirAbs) {
  const out = [];
  for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const p = path.join(dirAbs, e.name);
    if (e.isDirectory()) out.push(...listarJs(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Expande a lista (diretorios e arquivos) em caminhos relativos com "/". */
function expandirModulos(lista, raiz = RAIZ) {
  const out = new Set();
  for (const item of lista) {
    const abs = path.join(raiz, item);
    if (item.endsWith('/')) {
      for (const f of listarJs(abs)) out.add(relativo(f, raiz));
    } else {
      if (!fs.existsSync(abs)) throw new Error('modulo do gate nao existe: ' + item);
      out.add(item);
    }
  }
  return [...out].sort();
}

function relativo(abs, raiz = RAIZ) {
  return path.relative(raiz, abs).split(path.sep).join('/');
}

/**
 * Le um lcov e devolve Map(caminho normalizado -> contagens).
 * Registro repetido do mesmo arquivo (um por processo de teste) e somado linha a
 * linha, nao sobrescrito: senao o ultimo processo "apagaria" o que os outros cobriram.
 */
function lerLcov(texto, normalizar = p => p) {
  const arquivos = new Map();
  let atual = null;
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (linha.startsWith('SF:')) {
      const nome = normalizar(linha.slice(3));
      atual = arquivos.get(nome);
      if (!atual) {
        atual = { linhas: new Map(), funcoes: new Map(), ramos: new Map() };
        arquivos.set(nome, atual);
      }
      atual.ordemFn = [];
      atual.fndaVistos = 0;
    } else if (!atual) {
      continue;
    } else if (linha.startsWith('DA:')) {
      const [n, c] = linha.slice(3).split(',');
      atual.linhas.set(n, (atual.linhas.get(n) || 0) + Number(c));
    } else if (linha.startsWith('FN:')) {
      const [n, ...nome] = linha.slice(3).split(',');
      const chave = n + ',' + nome.join(',');
      if (!atual.funcoes.has(chave)) atual.funcoes.set(chave, 0);
      atual.ordemFn.push(chave);
    } else if (linha.startsWith('FNDA:')) {
      // FNDA nao traz a linha e o nome pode repetir (duas funcoes "arg"); o Node
      // escreve os FNDA na mesma ordem dos FN, entao casa por posicao.
      const chave = atual.ordemFn[atual.fndaVistos++];
      if (chave) atual.funcoes.set(chave, atual.funcoes.get(chave) + Number(linha.slice(5).split(',')[0]));
    } else if (linha.startsWith('BRDA:')) {
      const [n, bloco, ramo, c] = linha.slice(5).split(',');
      const chave = n + ',' + bloco + ',' + ramo;
      atual.ramos.set(chave, (atual.ramos.get(chave) || 0) + (c === '-' ? 0 : Number(c)));
    } else if (linha === 'end_of_record') {
      atual = null;
    }
  }
  for (const reg of arquivos.values()) { delete reg.ordemFn; delete reg.fndaVistos; }
  return arquivos;
}

function pct(cobertos, total) {
  return total === 0 ? 100 : Math.floor((cobertos / total) * 10000) / 100;
}

/** Resume um registro do lcov: percentuais e o que falta cobrir. */
function resumir(reg) {
  const linhasZero = [...reg.linhas].filter(([, c]) => c === 0).map(([n]) => Number(n));
  const funcoesZero = [...reg.funcoes].filter(([, c]) => c === 0).map(([k]) => k);
  const ramosZero = [...reg.ramos].filter(([, c]) => c === 0).map(([k]) => Number(k.split(',')[0]));
  return {
    linhas: pct(reg.linhas.size - linhasZero.length, reg.linhas.size),
    funcoes: pct(reg.funcoes.size - funcoesZero.length, reg.funcoes.size),
    ramos: pct(reg.ramos.size - ramosZero.length, reg.ramos.size),
    linhasZero,
    funcoesZero,
    ramosZero: [...new Set(ramosZero)].sort((a, b) => a - b),
  };
}

/**
 * Avalia a lista de modulos contra o lcov lido. Pura: recebe o conteudo das
 * fontes por funcao para poder ser testada sem disco.
 */
function avaliar(modulos, arquivosLcov, lerFonte) {
  const resultado = [];
  for (const m of modulos) {
    const reg = arquivosLcov.get(m);
    const problemas = [];
    let resumo;
    if (!reg) {
      resumo = { linhas: 0, funcoes: 0, ramos: 0, linhasZero: [], funcoesZero: [], ramosZero: [] };
      problemas.push('nenhum teste carregou este modulo');
    } else {
      resumo = resumir(reg);
      if (resumo.linhas < 100) problemas.push('linhas sem cobertura: ' + compactar(resumo.linhasZero));
      if (resumo.funcoes < 100) problemas.push('funcoes sem cobertura: ' + resumo.funcoesZero.join(' | '));
      if (resumo.ramos < 100) problemas.push('ramos sem cobertura nas linhas: ' + compactar(resumo.ramosZero));
    }
    const fonte = lerFonte(m);
    if (fonte != null && fonte.includes('node:coverage')) problemas.push('usa comentario node:coverage (trecho ignorado)');
    resultado.push({ modulo: m, ...resumo, problemas, ok: problemas.length === 0 });
  }
  return resultado;
}

/** [3,4,5,9] -> "3-5 9" */
function compactar(nums) {
  const ord = [...new Set(nums)].sort((a, b) => a - b);
  const partes = [];
  for (let i = 0; i < ord.length; i++) {
    let j = i;
    while (j + 1 < ord.length && ord[j + 1] === ord[j] + 1) j++;
    partes.push(i === j ? String(ord[i]) : ord[i] + '-' + ord[j]);
    i = j;
  }
  return partes.join(' ');
}

function formatarTabela(resultado) {
  const larg = Math.max(6, ...resultado.map(r => r.modulo.length));
  const cab = 'modulo'.padEnd(larg) + ' | linhas | funcoes |  ramos';
  const linhas = [cab, '-'.repeat(cab.length)];
  for (const r of resultado) {
    const f = v => v.toFixed(2).padStart(6);
    linhas.push(r.modulo.padEnd(larg) + ' | ' + f(r.linhas) + ' |  ' + f(r.funcoes) + ' | ' + f(r.ramos) + (r.ok ? '' : '  <- FALHA'));
    for (const p of r.problemas) linhas.push('    ' + p);
  }
  return linhas.join('\n');
}

function main() {
  const relatorio = process.argv.includes('--relatorio');
  const dirTeste = path.join(RAIZ, 'test');
  const arquivosTeste = fs.readdirSync(dirTeste).filter(f => f.endsWith('.test.js')).sort()
    .map(f => path.join('test', f));
  const destino = path.join(RAIZ, 'coverage', 'lcov.info');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  try { fs.unlinkSync(destino); } catch { /* primeira execucao */ }

  const r = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=' + destino,
    ...arquivosTeste,
  ], { cwd: RAIZ, stdio: 'inherit' });

  if (r.status !== 0) {
    console.error('\n[gate] testes falharam (codigo ' + r.status + ') — cobertura nem foi avaliada.');
    process.exit(r.status || 1);
  }
  if (!fs.existsSync(destino)) {
    console.error('\n[gate] o reporter lcov nao gerou ' + destino);
    process.exit(1);
  }

  const lcov = lerLcov(fs.readFileSync(destino, 'utf8'), p => relativo(path.resolve(RAIZ, p)));
  const extra = process.argv.filter(a => a.startsWith('--modulos=')).map(a => a.slice(10).split(','))[0];
  const modulos = expandirModulos(extra || MODULOS_NO_GATE);
  const resultado = avaliar(modulos, lcov, m => {
    try { return fs.readFileSync(path.join(RAIZ, m), 'utf8'); } catch { return null; }
  });

  console.log('\n[gate] cobertura da logica de negocio (' + modulos.length + ' modulos)\n');
  console.log(formatarTabela(resultado));
  const falhas = resultado.filter(x => !x.ok);
  if (falhas.length && !relatorio) {
    console.error('\n[gate] FALHOU: ' + falhas.length + ' modulo(s) abaixo de 100%.');
    process.exit(1);
  }
  console.log('\n[gate] ' + (falhas.length ? falhas.length + ' abaixo de 100% (modo relatorio)' : 'ok: todos os modulos em 100%'));
}

if (require.main === module) main();

module.exports = { MODULOS_NO_GATE, expandirModulos, lerLcov, resumir, avaliar, compactar, formatarTabela };
