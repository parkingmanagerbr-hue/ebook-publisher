'use strict';
/**
 * travaLocal.js — um publicador por loja, venha de onde vier.
 *
 * 26/09/2026, medido no catalogo: 27 dos 110 produtos criados no dia na
 * Hotmart tinham TITULO REPETIDO, alguns em triplicata. A causa nao era a
 * fila: eram DOIS publicadores no mesmo Chrome — a tarefa agendada
 * `GENIA-Hotmart` (publicar_local --limite=6, a cada 30 min) e um lote lancado
 * a mao (--limite=18). Cada um leu a fila no seu inicio; o livro que o outro
 * publicou no meio do caminho ainda estava "pendente" para ele.
 *
 * (Os 39 duplicados de 24/09 tinham a mesma cara: ids consecutivos, mesmo
 * titulo. Na epoca foi tratado como falha de leitura de catalogo.)
 *
 * Produto duplicado em marketplace nao se desfaz sozinho — e a trava tem de
 * estar no PROGRAMA, nao em quem o chama: quem esquece de travar e sempre a
 * chamada nova.
 *
 * A trava e um arquivo. Vence por IDADE porque o dono pode morrer sem soltar
 * (container recriado, maquina reiniciada, Ctrl+C): trava eterna para a
 * publicacao para sempre, e isso e pior que o risco que ela evita.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Quanto tempo uma trava abandonada ainda vale. Lote longo cabe folgado. */
const VALIDADE_MS = 2 * 60 * 60 * 1000;

/**
 * O disco, atras de tres funcoes. Existe para o teste poder encenar a corrida
 * entre dois processos (a trava que some entre a recusa e a leitura, o rival
 * que chega primeiro) — que e justamente o caso que a trava existe para tratar
 * e que nao da para reproduzir com arquivo de verdade.
 */
const DISCO = {
  /**
   * Cria o arquivo so se ele NAO existir. Devolve false se ja havia.
   * Grava DENTRO quem travou e quando: sem isso, "ja existe uma publicacao em
   * andamento" nao diz de quem, e o diagnostico vira adivinhacao.
   */
  criar(arquivo, dono) {
    let fd;
    try { fd = fs.openSync(arquivo, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    try { fs.writeSync(fd, JSON.stringify(dono || {})); } finally { fs.closeSync(fd); }
    return true;
  },
  /** Quando o arquivo foi criado, ou null se ele nao esta mais la. */
  quando(arquivo) {
    try { return fs.statSync(arquivo).mtimeMs; } catch (_) { return null; }
  },
  /** Quem travou, como ficou gravado. Vazio quando nao da para saber. */
  dono(arquivo) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (_) { return null; }
  },
  remover(arquivo) {
    try { fs.unlinkSync(arquivo); } catch (_) { /* outro ja tirou */ }
  },
};

/** Quem esta com a trava, em uma linha, para o log. Pura. */
function descreverDono(dono) {
  if (!dono || typeof dono !== 'object') return 'dono desconhecido';
  const o = String(dono.o_que == null ? '?' : dono.o_que).replace(new RegExp('[' + String.fromCharCode(13, 10, 9) + ']+', 'g'), ' ').slice(0, 40);
  return o + ' (pid ' + (dono.pid == null ? '?' : dono.pid) + ', desde ' + (dono.desde || '?') + ')';
}

/** Quem esta segurando a trava desta loja agora, ou null. */
function donoDaTrava(nome, opcoes = {}) {
  const disco = opcoes.disco || DISCO;
  return disco.dono(caminhoDaTrava(nome, opcoes.pasta));
}

/** Onde mora a trava desta loja. Nome vira nome de arquivo, sem sair da pasta. */
function caminhoDaTrava(nome, pasta) {
  const base = pasta || process.env.TRAVA_DIR || os.tmpdir();
  return path.join(base, 'publicador-' + String(nome).replace(/[^a-z0-9_-]/gi, '_') + '.lock');
}

/**
 * Tenta travar. Devolve a funcao que solta, ou `null` se ja ha outro rodando.
 *
 * `opcoes.agora`, `opcoes.validadeMs` e `opcoes.disco` existem para o teste
 * medir a expiracao e a corrida sem esperar duas horas nem subir dois
 * processos.
 */
function travar(nome, opcoes = {}) {
  const disco = opcoes.disco || DISCO;
  const arquivo = caminhoDaTrava(nome, opcoes.pasta);
  const agora = opcoes.agora || Date.now();
  const validade = opcoes.validadeMs == null ? VALIDADE_MS : opcoes.validadeMs;
  const avisar = opcoes.avisar || (() => {});

  const eu = { pid: process.pid, desde: new Date(agora).toISOString(), o_que: opcoes.oQue || path.basename(process.argv[1] || 'desconhecido') };
  if (!disco.criar(arquivo, eu)) {
    const nascida = disco.quando(arquivo);
    // Sumiu entre a recusa e a leitura: o dono soltou agorinha, a trava esta livre.
    const idade = nascida == null ? Infinity : agora - nascida;
    if (idade < validade) return null;
    if (nascida != null) avisar('trava de "' + nome + '" abandonada ha ' + Math.round(idade / 60000) + ' min por ' + descreverDono(disco.dono && disco.dono(arquivo)) + ' — assumindo');
    disco.remover(arquivo);
    // Outro processo pode ter assumido no mesmo instante: quem perder, espera.
    if (!disco.criar(arquivo, eu)) return null;
  }

  let solto = false;
  return () => {
    if (solto) return;
    solto = true;
    disco.remover(arquivo);
  };
}

module.exports = { travar, caminhoDaTrava, donoDaTrava, descreverDono, VALIDADE_MS, DISCO };
