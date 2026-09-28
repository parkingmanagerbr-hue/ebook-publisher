'use strict';
/**
 * diarioDeTestes.js — histórico de cada rodada da suite, para dar de olhar.
 *
 * O portao de cobertura diz "passou" ou "falhou" e acaba ali. Quem quer saber
 * *quando* um teste comecou a falhar, se a cobertura esta caindo ou ha quanto
 * tempo a suite nao roda, nao tem onde olhar — e foi assim que uma suite
 * quebrada por DISCO CHEIO passou por "test failed" sem explicacao
 * (27/09/2026).
 *
 * O diario e uma linha JSON por rodada (JSON Lines): cresce sem reescrever o
 * arquivo, e cada linha se le sozinha.
 *
 * As funcoes daqui sao puras; quem grava e quem le o disco e o script.
 */

/**
 * Extrai o placar da saida TAP do `node --test`. Pura.
 *
 * Le os totais do rodape (`# pass`, `# fail`, ...). Se o rodape nao veio, a
 * suite MORREU no meio (foi o caso do disco cheio) — e isso precisa aparecer
 * como falha, nunca como "0 falhas".
 */
function lerPlacar(saidaTap) {
  const texto = String(saidaTap == null ? '' : saidaTap);
  // DOIS formatos, porque os dois aparecem na pratica: o TAP puro
  // ("# pass 12") e o relatorio padrao do `node --test` ("ℹ pass 776"). Ler so
  // um deles registrava a suite VERDE como "nao terminou" — alarme falso, que
  // ensina a ignorar o alarme (27/09/2026).
  const INFO = String.fromCharCode(8505);   // ℹ
  const numero = nome => {
    const m = texto.match(new RegExp('^(?:# |[ \\t]*' + INFO + ' )' + nome + ' (\\d+)[ \\t]*$', 'm'));
    return m ? Number(m[1]) : null;
  };
  const passou = numero('pass');
  const falhou = numero('fail');
  if (passou == null || falhou == null) {
    return { completou: false, passou: passou || 0, falhou: falhou || 0, pulados: 0, total: 0 };
  }
  const pulados = (numero('skipped') || 0) + (numero('todo') || 0);
  return { completou: true, passou, falhou, pulados, total: passou + falhou + pulados };
}

/** Nomes dos testes que falharam, na ordem em que apareceram. Pura. */
function testesQueFalharam(saidaTap) {
  const linhas = String(saidaTap == null ? '' : saidaTap).split(/\r?\n/);
  const out = [];
  for (const l of linhas) {
    const m = l.match(/^not ok \d+ - (.+)$/);
    if (m) out.push(m[1].trim().slice(0, 120));
  }
  return out;
}

/** Cobertura global (linhas) da tabela do c8/node. Devolve null se nao houver. Pura. */
function lerCobertura(saida) {
  const m = String(saida == null ? '' : saida).match(/all files\s*\|\s*([\d.]+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Monta a linha do diario. `agora` e injetavel para o teste. Pura.
 */
function linhaDoDiario({ saida, coberturaOk, segundos, agora = Date.now(), rotulo = 'suite' } = {}) {
  const placar = lerPlacar(saida);
  const falhas = testesQueFalharam(saida);
  return {
    quando: new Date(agora).toISOString(),
    rotulo: String(rotulo).replace(/[\r\n\t]+/g, ' ').slice(0, 40),
    ok: placar.completou && placar.falhou === 0 && coberturaOk !== false,
    completou: placar.completou,
    passou: placar.passou,
    falhou: placar.falhou,
    pulados: placar.pulados,
    cobertura: lerCobertura(saida),
    coberturaOk: coberturaOk === undefined ? null : !!coberturaOk,
    segundos: Number(segundos) > 0 ? Math.round(Number(segundos)) : null,
    // Só os nomes, nunca o corpo do erro: diario e para olhar de relance.
    falharam: falhas.slice(0, 10),
  };
}

/**
 * Resumo legivel de um punhado de linhas do diario (a mais nova primeiro).
 * Pura.
 */
function resumoDoDiario(linhas) {
  const lista = (linhas || []).filter(Boolean);
  if (!lista.length) return 'diario vazio: a suite ainda nao rodou';
  const ultima = lista[0];
  const quebrouAgora = lista.findIndex(l => l.ok);
  const desde = quebrouAgora === -1 ? lista.length : quebrouAgora;
  const partes = [
    ultima.ok ? 'VERDE' : 'VERMELHO',
    ultima.passou + ' passaram',
    ultima.falhou + ' falharam',
    ultima.cobertura == null ? 'sem medida de cobertura' : 'cobertura ' + ultima.cobertura + '%',
    'em ' + (ultima.segundos == null ? '?' : ultima.segundos) + 's',
  ];
  if (!ultima.completou) partes.push('A SUITE NAO TERMINOU (morreu no meio)');
  if (!ultima.ok && desde > 1) partes.push('vermelho ha ' + desde + ' rodadas');
  if (!ultima.ok && ultima.falharam.length) partes.push('falhando: ' + ultima.falharam.slice(0, 3).join(' | '));
  return partes.join(' | ');
}

module.exports = { lerPlacar, testesQueFalharam, lerCobertura, linhaDoDiario, resumoDoDiario };
