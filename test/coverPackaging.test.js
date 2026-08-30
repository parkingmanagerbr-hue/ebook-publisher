// Travas da embalagem da capa.
//
// A capa e o unico ativo que o comprador ve antes de decidir. Cada caso aqui
// veio de um defeito visto A OLHO numa capa gerada em producao — texto cortado
// no meio da palavra, kicker invadindo o badge — ou de uma regra do playbook
// viral que o LLM tende a violar.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Memoria isolada: o bandit grava em disco, e um teste jamais pode sujar o
// placar real que decide qual gancho o sistema usa em producao.
const MEM = path.join(os.tmpdir(), 'cover-mem-' + process.pid + '.json');
process.env.COVER_PACKAGING_MEMORY = MEM;

const {
  limitar, escolherHook, registrarUso, pontuarHook, placar, HOOKS,
} = require('../src/agents/coverPackaging');

function limparMemoria() { try { fs.unlinkSync(MEM); } catch {} }

// ── limitar ─────────────────────────────────────────────────────────────────
// Bug real, visto numa capa: "30 DIAS GARANTIDOS" saiu como "30 DIAS GARANT".

test('limitar nao corta palavra pela metade em texto curto', () => {
  const r = limitar('30 DIAS GARANTIDOS', 16);
  assert.equal(r, '30 DIAS', 'o corte tem de cair no espaco, nunca dentro da palavra');
  assert.ok(!r.endsWith('GARANT'));
});

test('limitar devolve intacto o que ja cabe', () => {
  assert.equal(limitar('CURTO', 20), 'CURTO');
  assert.equal(limitar('EXATO NO LIMITE', 15), 'EXATO NO LIMITE');
});

test('limitar corta no espaco em frase longa', () => {
  const r = limitar('VIVENDO DE SALARIO MINIMO TODO MES', 20);
  assert.ok(r.length <= 20);
  assert.ok(!r.endsWith(' '));
  assert.equal(r, 'VIVENDO DE SALARIO');
});

test('limitar aceita corte seco quando o espaco cortaria quase tudo', () => {
  // "SUPERCALIFRAGILISTICO ok" em 20: o unico espaco esta em 21 (fora), entao
  // nao ha onde cortar — corte seco e o comportamento correto, e melhor que
  // devolver string vazia.
  const r = limitar('SUPERCALIFRAGILISTICOEXPI', 20);
  assert.equal(r.length, 20);
});

test('limitar remove aspas que o LLM adiciona sozinho', () => {
  assert.equal(limitar('"Pare de adiar"', 40), 'Pare de adiar');
  assert.equal(limitar("'Pare de adiar'", 40), 'Pare de adiar');
});

test('limitar tolera entrada nula', () => {
  for (const v of [null, undefined, '']) assert.equal(limitar(v, 10), '');
});

test('limitar nunca devolve texto maior que o limite', () => {
  // Invariante do layout: qualquer estouro vaza para fora da area desenhada.
  const amostras = ['a b c d e f g h i j k l m', 'PALAVRAUNICAENORMEDEMAIS', 'x y', '   espacos   nas   pontas   '];
  for (const s of amostras) for (const max of [5, 12, 14, 28, 40, 60]) {
    assert.ok(limitar(s, max).length <= max, `"${s}" em ${max} estourou`);
  }
});

// ── bandit ──────────────────────────────────────────────────────────────────

test('escolherHook sempre devolve uma tecnica valida, mesmo sem memoria', () => {
  limparMemoria();
  for (let i = 0; i < 25; i++) {
    const h = escolherHook();
    assert.ok(HOOKS.some(x => x.id === h.id), 'tecnica fora do catalogo: ' + h.id);
    assert.ok(h.desc && h.desc.length > 10, 'a descricao vai no prompt; vazia quebraria a geracao');
  }
});

test('sem dados nenhuma tecnica e privilegiada — a exploracao decide', () => {
  limparMemoria();
  const vistos = new Set();
  for (let i = 0; i < 300; i++) vistos.add(escolherHook().id);
  assert.ok(vistos.size >= 4, 'placar zerado nao pode cristalizar numa unica tecnica, vi: ' + vistos.size);
});

test('a tecnica que vendeu passa a ser escolhida com mais frequencia', () => {
  limparMemoria();
  for (const h of HOOKS) registrarUso(h.id, { topico: 't' });
  pontuarHook('contraintuitivo', 50);   // sinal forte de venda

  let ganhou = 0;
  for (let i = 0; i < 200; i++) if (escolherHook().id === 'contraintuitivo') ganhou++;
  // Com EPSILON=0.15 o teto teorico e ~87%; exigir maioria folgada basta para
  // provar que a recompensa realmente move a escolha.
  assert.ok(ganhou > 120, 'a tecnica premiada deveria dominar; venceu so ' + ganhou + '/200');
});

test('registrarUso conta os usos sem inventar pontuacao', () => {
  limparMemoria();
  registrarUso('dor', { topico: 'financas' });
  registrarUso('dor', { topico: 'saude' });
  const linha = placar().find(h => h.id === 'dor');
  assert.equal(linha.usos, 2);
  assert.equal(linha.media, 0, 'uso nao e venda: sem sinal real a media fica zero');
});

test('pontuarHook acumula em vez de sobrescrever', () => {
  limparMemoria();
  registrarUso('numero', { topico: 't' });
  registrarUso('numero', { topico: 't' });
  pontuarHook('numero', 4);
  pontuarHook('numero', 6);
  const linha = placar().find(h => h.id === 'numero');
  assert.equal(linha.media, 5, '(4+6)/2 usos');
});

test('placar vem ordenado da melhor para a pior', () => {
  limparMemoria();
  for (const h of ['dor', 'urgencia', 'pergunta']) registrarUso(h, { topico: 't' });
  pontuarHook('urgencia', 9);
  pontuarHook('dor', 3);
  const p = placar();
  assert.equal(p[0].id, 'urgencia');
  assert.ok(p[0].media >= p[1].media && p[1].media >= p[2].media);
});

test('memoria corrompida no disco nao derruba a geracao', () => {
  // Disco cheio ou processo morto no meio da escrita ja deixaram JSON pela
  // metade. Capa com texto padrao e aceitavel; pipeline parado nao e.
  fs.writeFileSync(MEM, '{ isto nao e json valido');
  assert.doesNotThrow(() => escolherHook());
  assert.doesNotThrow(() => placar());
  limparMemoria();
});

test('todas as tecnicas do catalogo tem id unico', () => {
  const ids = HOOKS.map(h => h.id);
  assert.equal(new Set(ids).size, ids.length, 'id repetido misturaria o placar de duas tecnicas');
});

test('o log da memoria nao cresce sem limite', () => {
  // O arquivo e lido e reescrito a cada capa; sem teto ele viraria um problema
  // de disco e de latencia.
  limparMemoria();
  for (let i = 0; i < 2100; i++) registrarUso('dor', { topico: 't' + i });
  const m = JSON.parse(fs.readFileSync(MEM, 'utf8'));
  assert.ok(m.log.length <= 2000, 'log passou do teto: ' + m.log.length);
  limparMemoria();
});
