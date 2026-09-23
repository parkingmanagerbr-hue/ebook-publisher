'use strict';
/**
 * navegadorLocal.js — achar (e manter de pe) o Chrome de automacao.
 *
 * Por que (22/09/2026): a publicacao na Hotmart e na Kiwify roda de dentro da
 * aba logada do Chrome do dono. O robo assumia a porta 9223 fixa; quando o
 * Chrome foi reaberto na 9222, o lote inteiro morreu com "SEM_SESSAO" e ninguem
 * percebeu ate olhar o log. Aqui ficam as decisoes puras: em que porta procurar,
 * o que cada loja precisa e o que dizer quando falta login humano.
 *
 * O robo NAO digita senha: quando a loja esta deslogada ele avisa, porque login
 * (e 2FA) e do titular da conta.
 */

/** Lojas que dependem do navegador local, com a pagina que prova o login. */
const LOJAS = {
  hotmart: { url: 'https://app.hotmart.com/', deslogado: /sso\.hotmart\.com|\/login/i },
  kiwify: { url: 'https://dashboard.kiwify.com/products', deslogado: /\/login|\/sign-?in/i },
  cakto: { url: 'https://app.cakto.com.br/dashboard/products?tab=products', deslogado: /sso\.cakto\.com\.br|\/accounts\/login/i },
  kdp: { url: 'https://kdp.amazon.com/pt_BR/bookshelf', deslogado: /ap\/signin|\/signin/i },
};

/** Portas onde procurar, na ordem: a do ambiente primeiro. Pura. */
function portasCandidatas(env = {}) {
  // Aceita "9223" ou a URL inteira ("http://127.0.0.1:9223"): pegar o primeiro
  // numero da URL devolvia 127 e o robo procurava numa porta que nao existe.
  const cru = String(env.CHROME_CDP_PORT || env.HOTMART_CDP_PORT || '').trim();
  const daMao = cru.match(/:(\d{2,5})(?:\D|$)/) || cru.match(/^(\d{2,5})$/);
  const lista = [];
  if (daMao) lista.push(Number(daMao[1]));
  for (const p of [9222, 9223]) if (!lista.includes(p)) lista.push(p);
  return lista;
}

/**
 * Primeira porta que responde. `testar(porta)` devolve true/false (ou promessa).
 * Devolve null quando nenhuma responde — ai o vigia abre o Chrome.
 */
async function escolherPorta(testar, portas) {
  for (const porta of portas) {
    let ok = false;
    try { ok = await testar(porta); } catch (_) { ok = false; }
    if (ok) return porta;
  }
  return null;
}

/** A URL em que a aba parou diz se a loja pediu login. Pura. */
function estaDeslogado(loja, urlFinal) {
  const regra = LOJAS[loja];
  if (!regra) return false;
  return regra.deslogado.test(String(urlFinal || ''));
}

/** Resumo do que o dono precisa fazer. Pura. */
function pendenciasDeLogin(estados) {
  const faltando = Object.entries(estados || {})
    .filter(([, v]) => v === 'deslogado')
    .map(([k]) => k)
    .sort();
  return {
    faltando,
    mensagem: faltando.length
      ? 'login humano necessario em: ' + faltando.join(', ') + ' (o robo nao digita senha nem 2FA)'
      : 'todas as lojas logadas',
  };
}

/** Argumentos para abrir o Chrome de automacao sem atrapalhar o Chrome do dia a dia. */
function argumentosDoChrome(porta, perfil, urls = []) {
  return [
    '--remote-debugging-port=' + Number(porta),
    '--user-data-dir=' + String(perfil),
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    ...urls,
  ];
}

module.exports = { LOJAS, portasCandidatas, escolherPorta, estaDeslogado, pendenciasDeLogin, argumentosDoChrome };
