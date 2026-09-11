'use strict';
/**
 * Protege duas coisas que ja quebraram em silencio.
 *
 * 1. CARACTERE DE CONTROLE NO FONTE. Em 11/09/2026 cinco regex sairam com
 *    backspace (0x08) no lugar de \b: a edicao engoliu uma barra e o Python leu
 *    "\b" como backspace. O regex continuava valido — so nunca casava. A
 *    correcao da janela deslizante do Groq ficou inerte e o filtro de alegacao
 *    de saude quase nao funcionava. Os testes da epoca passaram porque
 *    REDIGITAVAM o regex em vez de carregar o modulo. Aqui se carrega o modulo.
 *
 * 2. ALEGACAO EM CAPA. Capa publica nao pode afirmar causa ou cura (CDC/CONAR).
 *    Positivos que o filtro TEM de pegar e negativos que NAO pode acusar — sem
 *    os dois lados, um filtro que nunca dispara parece funcionar.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getErrorTTL } = require('../src/core/aiClient');
const { ALEGACAO, ehNichoSaude, TECNICAS_VEDADAS_SAUDE, escolherHook } = require('../src/agents/coverPackaging');

function arquivosJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...arquivosJs(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('nenhum arquivo-fonte tem caractere de controle (escape de regex engolido)', () => {
  const raiz = path.join(__dirname, '..');
  const achados = [];
  for (const f of [...arquivosJs(path.join(raiz, 'src')), ...arquivosJs(path.join(raiz, 'scripts'))]) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(l)) achados.push(path.relative(raiz, f) + ':' + (i + 1));
    });
  }
  assert.deepStrictEqual(achados, [], 'caractere de controle em: ' + achados.join(', '));
});

const erro = msg => ({ response: { status: 429, data: { error: { message: msg } } }, message: 'status code 429' });

test('limite diario do Groq respeita a janela deslizante (dica "try again in")', () => {
  const r = getErrorTTL(erro('on tokens per day (TPD): Limit 200000, Used 199895. Please try again in 7m35.76s.'));
  assert.ok(Math.abs(r.hours * 3600 - 485.76) < 1, 'esperado ~486 s, veio ' + (r.hours * 3600));
});

test('limite por minuto usa a dica, com piso de 15 s', () => {
  const r = getErrorTTL(erro('on tokens per minute (TPM): Limit 8000. Please try again in 6.9s.'));
  assert.strictEqual(Math.round(r.hours * 3600), 15);
});

test('cota diaria sem dica trava ate a meia-noite UTC', () => {
  const r = getErrorTTL(erro('You exceeded your current quota, please check your plan.'));
  assert.ok(r.hours >= 0.5);
});

test('"today" solto NAO e confundido com cota diaria (controle negativo)', () => {
  const r = getErrorTTL(erro('Rate limit on requests per minute. Upgrade to Dev Tier today.'));
  assert.ok(r.hours < 0.1, 'veio ' + r.hours + ' h');
});

test('filtro de alegacao pega causa, cura e culpado', () => {
  for (const t of ['CURA A DOR DAS COSTAS', 'SUAS DORES VÊM DA INDÚSTRIA', 'TRATA A ANSIEDADE',
                   'ESTE ALIMENTO CAUSA INFLAMAÇÃO', 'HEALS YOUR GUT'])
    assert.ok(ALEGACAO.test(t), 'deveria pegar: ' + t);
});

test('filtro de alegacao nao acusa gancho legitimo', () => {
  for (const t of ['DORMIR MELHOR EM 7 DIAS', 'SEM TEMPO PARA TREINAR?', 'COZINHA PRÁTICA DO DIA A DIA',
                   'SEGURANÇA NA MESA', 'TRATOR NA FAZENDA'])
    assert.ok(!ALEGACAO.test(t), 'nao deveria acusar: ' + t);
});

test('em nicho de saude o bandit nunca sorteia tecnica de afirmacao causal', () => {
  const memoria = { hooks: {} };
  for (let i = 0; i < 400; i++) {
    const h = escolherHook(memoria, 'saude', 'dieta anti-inflamatoria');
    assert.ok(!TECNICAS_VEDADAS_SAUDE.has(h.id), 'sorteou ' + h.id + ' em saude');
  }
});

test('fora de saude as tecnicas continuam disponiveis', () => {
  assert.ok(!ehNichoSaude('financas', 'fundo de emergencia'));
  const vistos = new Set();
  for (let i = 0; i < 600; i++) vistos.add(escolherHook({ hooks: {} }, 'financas', 'fundo de emergencia').id);
  assert.ok(vistos.has('inimigo_comum') || vistos.has('contraintuitivo'), 'nichos comuns devem manter as 8 tecnicas');
});
