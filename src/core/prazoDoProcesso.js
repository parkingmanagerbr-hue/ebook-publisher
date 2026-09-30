'use strict';
/**
 * prazoDoProcesso.js — nenhum script que fala com o Chrome pode viver para sempre.
 *
 * 30/09/2026: `sessaoHotmart` (chamado pelo laco) ficou pendurado das 19:33 e
 * `vigia_navegador` (chamado pela tarefa agendada) das 19:45, os dois esperando
 * uma operacao do Chrome que nunca respondeu. O Chrome estava de pe (o /json
 * respondia em milissegundos); quem travou foi uma chamada la dentro. Com a
 * tarefa "em execucao", as rodadas seguintes nem comecavam — quase uma hora de
 * publicacao parada, sem erro nem log.
 *
 * Um travamento de navegador nao levanta excecao: a promessa so nunca resolve.
 * Por isso o prazo e do PROCESSO, armado no inicio: estourou, registra e sai com
 * codigo proprio (3), e quem chamou segue para a proxima coisa.
 */

const CODIGO_PRAZO = 3;

/**
 * Arma o prazo. Devolve o temporizador (ja com `unref`, para nao segurar um
 * processo que terminou antes). `sair` e injetavel para o teste.
 */
function armarPrazoDoProcesso({ ms, oQue = 'processo', log = console, sair = process.exit } = {}) {
  const limite = Number(ms);
  if (!Number.isFinite(limite) || limite <= 0) return null;
  const t = setTimeout(() => {
    try {
      log.error('PRAZO DO PROCESSO: ' + String(oQue).replace(/[\r\n\t]+/g, ' ').slice(0, 60) +
        ' passou de ' + Math.round(limite / 60000) + ' min sem terminar — encerrando (provavel travamento no Chrome)');
    } catch (_) { /* avisar nao pode impedir de sair */ }
    sair(CODIGO_PRAZO);
  }, limite);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { armarPrazoDoProcesso, CODIGO_PRAZO };
