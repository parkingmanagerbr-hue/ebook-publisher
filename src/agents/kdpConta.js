'use strict';
/**
 * kdpConta.js — a conta do KDP ja deixa publicar?
 *
 * 05/10/2026: o fluxo de publicacao funciona ate o fim, mas o botao Publicar
 * fica cinza com "Informacoes de conta incompletas" enquanto a conta bancaria
 * nao e aceita (verificacao de ate 3 dias). Rodar o publicador antes disso cria
 * um rascunho novo a cada tentativa, que nunca sai. Esta decisao fica antes.
 * Puro: recebe o texto da pagina da conta.
 */
function contaLiberada(textoDaConta) {
  const t = String(textoDaConta || '');
  if (!/Receber pagamento|Get paid/i.test(t)) return { liberada: false, motivo: 'pagina da conta nao carregou' };
  if (/A[çc][ãa]o necess[áa]ria|Action required/i.test(t)) {
    const linha = (t.match(/[^\n]*(conta banc[áa]ria|bank account)[^\n]*/i) || [''])[0].trim().slice(0, 160);
    return { liberada: false, motivo: linha || 'conta com acao necessaria' };
  }
  return { liberada: true, motivo: '' };
}

module.exports = { contaLiberada };
