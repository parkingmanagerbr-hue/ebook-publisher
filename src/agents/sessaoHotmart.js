'use strict';
/**
 * sessaoHotmart.js — o que fazer quando a Hotmart parece deslogada.
 *
 * 26/09/2026, medido: oito lotes seguidos publicaram ZERO e o vigia dizia
 * "hotmart: deslogado". O painel, aberto de verdade, estava LOGADO — o que
 * tinha morrido era a aba do app (a sessao OIDC so se renova com aba viva) e,
 * por tabela, o token do servidor vencera (catalogo HTTP 401). Bastou abrir o
 * painel e renovar: nenhuma senha foi necessaria.
 *
 * Ou seja: "deslogado" pelo vigia NAO e diagnostico suficiente para acordar o
 * dono de madrugada. Primeiro se abre a tela e se olha o que ela mostra.
 *
 * Tres estados possiveis, e so o terceiro precisa de gente:
 *   'logado'        — o painel abriu; e so renovar o token
 *   'sessao-salva'  — a tela oferece continuar como <conta>, sem pedir senha
 *   'precisa-humano'— pede senha ou codigo de 2FA
 *
 * O robo NUNCA digita senha nem codigo: credencial de loja e do dono. Clicar em
 * "continuar" numa sessao que o proprio navegador ja guarda e outra coisa — nao
 * ha segredo sendo digitado.
 *
 * Tudo aqui e puro: recebe o que a tela mostra e decide.
 */

/** Campo onde se digita segredo: se existe e esta visivel, e trabalho de gente. */
function pedeSegredo(campos) {
  return (campos || []).some(c => {
    if (!c || c.visivel === false) return false;
    const tipo = String(c.tipo || '').toLowerCase();
    const nome = String(c.nome || '') + ' ' + String(c.ph || '');
    if (tipo === 'password') return true;
    return /c[oó]digo|token|verifica|otp|2fa|autentica/i.test(nome);
  });
}

/** Botao que continua com a conta ja guardada, sem pedir segredo. */
function botaoDeSessaoSalva(botoes) {
  const alvo = /^(continuar|continue|entrar|acessar|sim,? sou eu|prosseguir)\b/i;
  const conta = /continuar como|continue as|entrar como/i;
  for (const b of botoes || []) {
    const t = String(b == null ? '' : b).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (conta.test(t) || alvo.test(t)) return t;
  }
  return null;
}

/** A tela e a do painel (e nao a de entrada)? */
function ehPainel(url, campos) {
  const u = String(url || '');
  if (!/^https:\/\/app\.hotmart\.com\//.test(u)) return false;
  // A pagina de entrada mora em outro dominio; no painel nao ha campo de senha.
  return !pedeSegredo(campos);
}

/**
 * Decide o que fazer com a tela que apareceu. Pura.
 * `tela`: { url, campos: [{tipo, nome, ph, visivel}], botoes: [texto] }
 */
function diagnosticarTela(tela) {
  const t = tela || {};
  if (pedeSegredo(t.campos)) {
    return { estado: 'precisa-humano', motivo: 'a tela pede senha ou codigo — so o dono digita isso', botao: null };
  }
  if (ehPainel(t.url, t.campos)) {
    return { estado: 'logado', motivo: 'o painel abriu sem pedir nada', botao: null };
  }
  const botao = botaoDeSessaoSalva(t.botoes);
  if (botao) {
    return { estado: 'sessao-salva', motivo: 'a tela oferece continuar com a conta ja guardada', botao };
  }
  return { estado: 'precisa-humano', motivo: 'tela desconhecida, sem botao de continuar', botao: null };
}

/** Uma linha de log, sem quebra e sem nada que lembre segredo. Pura. */
function resumoDaSessao(diagnostico, url) {
  const d = diagnostico || {};
  const limpa = String(url == null ? '' : url).split('?')[0].replace(/[\r\n\t]+/g, ' ').slice(0, 80);
  return 'sessao Hotmart: ' + (d.estado || '?') + ' — ' + String(d.motivo || '').replace(/[\r\n\t]+/g, ' ').slice(0, 90) + ' | ' + limpa;
}

module.exports = { diagnosticarTela, pedeSegredo, botaoDeSessaoSalva, ehPainel, resumoDaSessao };
