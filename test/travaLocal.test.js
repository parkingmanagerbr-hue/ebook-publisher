'use strict';
/**
 * travaLocal: a trava que impede DOIS publicadores na mesma loja.
 *
 * Em 26/09/2026 a tarefa agendada e um lote lancado a mao publicaram juntos na
 * Hotmart: 27 dos 110 produtos do dia sairam com titulo repetido, alguns em
 * triplicata. Se alguem afrouxar esta regra, o teste tem de ficar vermelho.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { travar, caminhoDaTrava, donoDaTrava, descreverDono, VALIDADE_MS } = require('../src/core/travaLocal');

const pastaNova = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trava-'));

test('o segundo publicador NAO entra enquanto o primeiro roda', () => {
  const pasta = pastaNova();
  const soltar = travar('hotmart', { pasta });
  assert.ok(soltar, 'o primeiro trava');
  assert.strictEqual(travar('hotmart', { pasta }), null, 'o segundo e recusado');
  soltar();
  assert.ok(travar('hotmart', { pasta }), 'depois de soltar, entra');
});

test('loja diferente nao disputa a mesma trava', () => {
  const pasta = pastaNova();
  assert.ok(travar('hotmart', { pasta }));
  assert.ok(travar('cakto', { pasta }), 'Cakto e Hotmart publicam em paralelo sem se atrapalhar');
});

test('trava abandonada vence pela idade (senao a publicacao para para sempre)', () => {
  const pasta = pastaNova();
  travar('hotmart', { pasta });                       // dono morre sem soltar
  const avisos = [];
  const depois = travar('hotmart', {
    pasta, agora: Date.now() + VALIDADE_MS + 1000, avisar: m => avisos.push(m),
  });
  assert.ok(depois, 'passada a validade, o proximo assume');
  assert.strictEqual(avisos.length, 1, 'assumir trava alheia deixa registro');
  assert.match(avisos[0], /abandonada ha \d+ min/);
  assert.ok(!/\r|\n/.test(avisos[0]));
});

test('trava recente de outro processo continua valendo', () => {
  const pasta = pastaNova();
  travar('hotmart', { pasta });
  assert.strictEqual(travar('hotmart', { pasta, agora: Date.now() + VALIDADE_MS - 60000 }), null);
});

test('soltar duas vezes nao derruba a trava de quem entrou depois', () => {
  const pasta = pastaNova();
  const soltar = travar('hotmart', { pasta });
  soltar();
  const outro = travar('hotmart', { pasta });
  assert.ok(outro, 'o segundo pegou a trava');
  soltar();                                            // chamada repetida do primeiro
  assert.strictEqual(travar('hotmart', { pasta }), null, 'a trava do segundo continua de pe');
  outro();
});

test('arquivo de trava sumido entre a recusa e a leitura nao quebra', () => {
  const pasta = pastaNova();
  const soltar = travar('hotmart', { pasta });
  fs.unlinkSync(caminhoDaTrava('hotmart', pasta));     // some no meio do caminho
  assert.ok(travar('hotmart', { pasta }), 'sem arquivo, a trava esta livre');
  soltar();
});

test('nome de loja com barra nao escapa da pasta da trava', () => {
  const pasta = pastaNova();
  const caminho = caminhoDaTrava('../../etc/passwd', pasta);
  assert.strictEqual(path.dirname(caminho), pasta);
  assert.ok(!caminho.includes('..'), caminho);
});

test('sem pasta informada, a trava vai para a pasta temporaria do sistema', () => {
  const antes = process.env.TRAVA_DIR;
  delete process.env.TRAVA_DIR;
  assert.strictEqual(path.dirname(caminhoDaTrava('hotmart')), os.tmpdir());
  process.env.TRAVA_DIR = path.join(os.tmpdir(), 'escolhida');
  assert.strictEqual(path.dirname(caminhoDaTrava('hotmart')), process.env.TRAVA_DIR);
  if (antes == null) delete process.env.TRAVA_DIR; else process.env.TRAVA_DIR = antes;
});

test('erro de disco nao vira "trava livre"', () => {
  const pasta = path.join(pastaNova(), 'que-nao-existe');
  assert.throws(() => travar('hotmart', { pasta }), /ENOENT/);
});

test('trava vencida sem ninguem para avisar nao quebra', () => {
  const pasta = pastaNova();
  travar('hotmart', { pasta });
  // `agora` no futuro: sem ele, a data do arquivo pode vir alguns
  // milissegundos adiante do relogio e a idade sai NEGATIVA (a trava parece
  // recem-criada). Preferir a trava nesse caso e o certo, mas nao e o que
  // este teste mede.
  const depois = travar('hotmart', { pasta, validadeMs: 0, agora: Date.now() + 5000 });
  assert.ok(depois, 'validade zero: assume na hora, sem ninguem para avisar');
});

test('a corrida perdida devolve null em vez de duas travas', () => {
  // Dois processos veem a trava vencida no mesmo instante; o rival cria antes.
  let tentativas = 0;
  const disco = {
    criar: () => { tentativas++; return false; },       // sempre ocupada
    quando: () => 0,                                     // vencidissima
    remover: () => {},
  };
  assert.strictEqual(travar('hotmart', { disco, agora: 10 * 60 * 60 * 1000, avisar: () => {} }), null);
  assert.strictEqual(tentativas, 2, 'tentou de novo depois de tirar a vencida, e desistiu');
});

test('trava que some entre a recusa e a leitura e tratada como livre, sem aviso', () => {
  const avisos = [];
  let n = 0;
  const disco = {
    criar: () => (n++ === 0 ? false : true),             // ocupada na 1a, livre na 2a
    quando: () => null,                                  // sumiu no meio do caminho
    remover: () => {},
  };
  const soltar = travar('hotmart', { disco, avisar: m => avisos.push(m) });
  assert.ok(soltar);
  assert.deepStrictEqual(avisos, [], 'nao houve trava abandonada para avisar');
});

test('o disco de verdade: arquivo que nao existe nao tem data e apagar nao lanca', () => {
  const { DISCO } = require('../src/core/travaLocal');
  const some = path.join(pastaNova(), 'nunca-existiu.lock');
  assert.strictEqual(DISCO.quando(some), null);
  assert.doesNotThrow(() => DISCO.remover(some));
  assert.strictEqual(DISCO.criar(some), true, 'criar sem dono informado nao quebra');
  assert.deepStrictEqual(DISCO.dono(some), {}, 'sem dono, fica um registro vazio (nunca invalido)');
  assert.ok(DISCO.quando(some) > 0);
  assert.strictEqual(DISCO.criar(some, { pid: 1 }), false, 'segunda vez encontra ocupado');
  DISCO.remover(some);
  assert.strictEqual(DISCO.quando(some), null);
});

test('a trava diz QUEM a segura (senao "ja existe publicacao" nao se investiga)', () => {
  const pasta = pastaNova();
  const soltar = travar('hotmart', { pasta, oQue: 'lote-manual' });
  const dono = donoDaTrava('hotmart', { pasta });
  assert.strictEqual(dono.pid, process.pid);
  assert.strictEqual(dono.o_que, 'lote-manual');
  assert.match(dono.desde, /^\d{4}-\d{2}-\d{2}T/);
  soltar();
  assert.strictEqual(donoDaTrava('hotmart', { pasta }), null, 'solta, nao ha dono');
});

test('o aviso de trava assumida nomeia o dono, em uma linha', () => {
  const pasta = pastaNova();
  travar('hotmart', { pasta, oQue: 'tarefa-agendada' });
  const avisos = [];
  travar('hotmart', { pasta, agora: Date.now() + VALIDADE_MS + 1000, avisar: m => avisos.push(m) });
  assert.match(avisos[0], /por tarefa-agendada \(pid \d+, desde /);
  assert.ok(!/[\r\n]/.test(avisos[0]));
});

test('arquivo de trava corrompido nao quebra o aviso nem a tomada', () => {
  const pasta = pastaNova();
  travar('hotmart', { pasta });
  fs.writeFileSync(caminhoDaTrava('hotmart', pasta), 'isto nao e json');
  assert.strictEqual(donoDaTrava('hotmart', { pasta }), null);
  const avisos = [];
  assert.ok(travar('hotmart', { pasta, agora: Date.now() + VALIDADE_MS + 1000, avisar: m => avisos.push(m) }));
  assert.match(avisos[0], /dono desconhecido/);
});

test('o nome do processo vem sanitizado e cortado no log', () => {
  assert.match(descreverDono({ pid: 7, desde: 'agora', o_que: 'a'.repeat(80) }), /^a{40} \(pid 7, desde agora\)$/);
  assert.strictEqual(descreverDono({ pid: null, desde: null }), '? (pid ?, desde ?)');
  assert.strictEqual(descreverDono('texto solto'), 'dono desconhecido');
});

test('processo sem nome conhecido ainda registra um dono', () => {
  const pasta = pastaNova();
  const antes = process.argv[1];
  process.argv[1] = '';
  try {
    travar('hotmart', { pasta });
    assert.strictEqual(donoDaTrava('hotmart', { pasta }).o_que, 'desconhecido');
  } finally { process.argv[1] = antes; }
});

test('trava NOVA de processo MORTO e livre — nao espera as duas horas', () => {
  // 30/09/2026: o Windows travou as 00:34, o publicador morreu no meio do lote
  // e a trava ficou com um pid inexistente. So a idade a liberaria.
  const avisos = [];
  let criadas = 0;
  const disco = {
    criar: () => (criadas++ === 0 ? false : true),
    quando: () => 1000,                                     // nascida agora mesmo
    dono: () => ({ pid: 424242, desde: 'x', o_que: 'publicar_local --limite=18' }),
    vivo: pid => pid !== 424242,                            // esse morreu
    remover: () => {},
  };
  const soltar = travar('hotmart', { disco, agora: 2000, avisar: m => avisos.push(m) });
  assert.ok(soltar, 'assumiu a trava do morto');
  assert.match(avisos[0], /ja morreu/);
  assert.match(avisos[0], /424242/);
});

test('trava NOVA de processo VIVO continua valendo (senao duplica produto)', () => {
  const disco = {
    criar: () => false,
    quando: () => 1000,
    dono: () => ({ pid: 777 }),
    vivo: () => true,
    remover: () => { throw new Error('nao pode remover trava de processo vivo'); },
  };
  assert.strictEqual(travar('hotmart', { disco, agora: 2000, avisar: () => {} }), null);
});

test('duvida sobre o dono BLOQUEIA: sem pid, pid estranho ou verificacao que falha', () => {
  const { donoMorreu } = require('../src/core/travaLocal');
  const morto = () => false;
  assert.strictEqual(donoMorreu({ pid: 424242 }, morto), true);
  assert.strictEqual(donoMorreu(null, morto), false, 'sem dono gravado nao da para saber');
  assert.strictEqual(donoMorreu('texto', morto), false);
  assert.strictEqual(donoMorreu({}, morto), false, 'sem pid');
  assert.strictEqual(donoMorreu({ pid: 'abc' }, morto), false);
  assert.strictEqual(donoMorreu({ pid: 0 }, morto), false);
  assert.strictEqual(donoMorreu({ pid: -5 }, morto), false);
  assert.strictEqual(donoMorreu({ pid: process.pid }, morto), false, 'eu mesmo nunca estou morto');
  assert.strictEqual(donoMorreu({ pid: 424242 }, () => { throw new Error('sem permissao'); }), false,
    'verificacao que falha conta como vivo');
  assert.strictEqual(donoMorreu({ pid: 424242 }, () => undefined), false, 'resposta ambigua conta como vivo');
});

test('o disco de verdade sabe quem esta vivo', () => {
  const { DISCO } = require('../src/core/travaLocal');
  assert.strictEqual(DISCO.vivo(process.pid), true);
  assert.strictEqual(DISCO.vivo(2147483646), false, 'pid que nao existe');
});
