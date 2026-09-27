'use strict';
/**
 * prazo.js — nenhum livro pode prender a fila para sempre.
 *
 * 26/09/2026, medido no log: o lote 46 publicou UM livro e travou no segundo,
 * na tela de preco. Ficou parado das 14:16 as 02:20 — DOZE HORAS com o
 * navegador aberto, sem erro, sem log, sem publicar. O orcamento `--minutos`
 * nao pegava: ele so impede COMECAR livro novo, e quem estava travado ja tinha
 * comecado.
 *
 * Travamento de automacao de navegador nao levanta excecao: a promessa
 * simplesmente nunca resolve (elemento que nao aparece, aba que morreu, SPA que
 * nao montou). Sem prazo, "esperar mais um pouco" dura o dia inteiro.
 *
 * O prazo e por ITEM, nao por lote: estourar um livro custa um livro, e a fila
 * segue. O de lote continua valendo para nao comecar trabalho que nao cabe.
 */

/** Erro de prazo estourado — quem chama distingue isto de falha da loja. */
class PrazoEstourado extends Error {
  constructor(ms, oQue) {
    super('PRAZO_ESTOURADO: ' + (oQue || 'tarefa') + ' passou de ' + Math.round(ms / 1000) + 's sem terminar');
    this.name = 'PrazoEstourado';
    this.prazo = true;
    this.ms = ms;
  }
}

/**
 * Roda `tarefa()` com prazo. Devolve o que ela devolver, ou lanca
 * PrazoEstourado quando o tempo acaba primeiro.
 *
 * A tarefa NAO e interrompida — nao ha como cancelar uma promessa em curso.
 * Quem chama precisa deixar o estado limpo depois (fechar a aba, por exemplo);
 * por isso o `aoEstourar`, que roda antes de lancar.
 *
 * `dormir` e injetavel para o teste nao esperar de verdade.
 */
function comPrazo(tarefa, ms, { oQue, aoEstourar, agendar = setTimeout, cancelar = clearTimeout } = {}) {
  if (!(ms > 0)) return Promise.resolve().then(tarefa);   // prazo desligado
  let relogio;
  const estourar = new Promise((_, rejeitar) => {
    relogio = agendar(() => {
      let motivo = null;
      try { if (aoEstourar) aoEstourar(); } catch (e) { motivo = e; }
      rejeitar(new PrazoEstourado(ms, oQue));
      // Falha na limpeza nao pode trocar o motivo do erro (o prazo e o que
      // interessa), mas nao pode sumir calada.
      if (motivo && typeof process !== 'undefined' && process.emitWarning) {
        process.emitWarning('limpeza apos prazo falhou: ' + String(motivo && motivo.message).slice(0, 120));
      }
    }, ms);
  });
  return Promise.race([Promise.resolve().then(tarefa), estourar])
    .finally(() => cancelar(relogio));
}

/**
 * Quanto tempo dar a um item, olhando o que os itens normais levam.
 *
 * Os livros que dao certo levam 2,5 a 3,5 min; o mais lento medido ficou em 5.
 * Tres vezes a mediana, com piso e teto, deixa folga para a loja lenta e ainda
 * corta o travamento em minutos em vez de horas. Pura.
 */
function prazoPorItem(minutosTipicos = 3, { fator = 3, minimo = 6, maximo = 25 } = {}) {
  const base = Number(minutosTipicos) > 0 ? Number(minutosTipicos) : 3;
  return Math.round(Math.min(maximo, Math.max(minimo, base * fator)) * 60000);
}

module.exports = { comPrazo, prazoPorItem, PrazoEstourado };
