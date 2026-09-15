'use strict';
/**
 * hotmartRegras.js — decisoes puras do cadastro na Hotmart, fora do navegador.
 *
 * Moravam dentro de publisherHotmart.js (2300 linhas de Puppeteer), onde nao
 * havia como testar. O publisher continua chamando e reexportando estas funcoes.
 */

const TECH_KW = ['web3','blockchain','programar','chatbot','cloud','saas','tecnologia','inteligencia artificial',' ia ','python','javascript','codigo','algoritmo','digital','nft','criptomoeda','linux','docker'];
const HEALTH_KW = ['saude','sono','depressao','panico','menopausa','hipertrofia','pressao','alcalina','alimentac','dieta','emagrecimento','fitness','exercicio','musculacao','mental','ansiedade','yoga','meditacao','hormonio','diabetes','colesterol'];
const FINANCE_KW = ['investimento','financ','dinheiro','consorcio','franquia','airbnb','freelancer','renda','patrimonio','aposentadoria','acoes','fundo','bitcoin','trading','bolsa','credito','emprestimo'];
const BUSINESS_KW = ['nomade','negocio','empreend','carreira','marketing','vendas','produtividade','lideranca','gestao','startup','cliente','lucro','estrategia','branding','copywriting','persona'];

function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

/** Texto normalizado, so letras e numeros, com espaco nas pontas para casar palavra. */
function emPalavras(s) {
  return ' ' + norm(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/**
 * A palavra-chave aparece no texto?
 *
 * Era `includes` puro, e palavra-chave curta dentro de outra palavra mandava o
 * livro para a categoria errada: "aprenda" tem "renda" (Negocios), "relacoes" e
 * "meditacoes" tem "acoes", "profundo" tem "fundo", "acredito" tem "credito",
 * "fundamental" tem "mental" e "expressao" tem "pressao" (Saude).
 *
 * Regra: chave curta (ate 7 letras) so casa no COMECO de uma palavra; chave
 * longa continua casando dentro de composta ("microempreendedor" e negocio,
 * "neuromarketing" tambem); chave escrita com espacos (" ia ") e palavra
 * inteira — a sigla IA nao pode casar "tia" nem "culinaria", mas precisa casar
 * "IA para Iniciantes", que a versao anterior perdia por exigir espaco antes.
 */
function casaPalavra(texto, chave) {
  const k = chave.trim();
  if (k !== chave) return texto.includes(' ' + k + ' ');
  if (k.length >= 8) return texto.includes(k);
  return texto.includes(' ' + k);
}

function getCategoryPT(title, topic) {
  const t = emPalavras(title + ' ' + (topic || ''));
  if (TECH_KW.some(k => casaPalavra(t, k)))     return 'Tecnologia e Programacao';
  if (HEALTH_KW.some(k => casaPalavra(t, k)))   return 'Saude e Esportes';
  if (FINANCE_KW.some(k => casaPalavra(t, k)))  return 'Negocios e Carreira';
  if (BUSINESS_KW.some(k => casaPalavra(t, k))) return 'Negocios e Carreira';
  return 'Desenvolvimento Pessoal';
}

/**
 * Digitos que se digitam no campo de preco da Hotmart. A mascara e da direita
 * para a esquerda (os dois ultimos digitos sao os centavos), entao o valor tem
 * de virar CENTAVOS: `replace(/[^0-9]/g,'')` puro transformava HOTMART_PRICE=5
 * em R$ 0,05 e 30 em R$ 0,30. Producao usa "5,00", onde os dois davam o mesmo.
 */
function digitosDoPreco(texto) {
  const s = String(texto == null ? '' : texto).replace(/[^0-9.,]/g, '');
  if (!s.replace(/[.,]/g, '')) return '';
  const comCentavos = s.match(/^(.*?)[.,](\d{1,2})$/);
  const reais = Number((comCentavos ? comCentavos[1] : s).replace(/[.,]/g, '') || '0');
  const centavos = comCentavos ? Number(comCentavos[2].padEnd(2, '0')) : 0;
  return String(reais * 100 + centavos);
}

/** Id numerico do produto na URL do wizard/gestao, ou null. */
function idProdutoDaUrl(u) {
  const m = u.match(/\/products\/manage\/(\d+)/) || u.match(/\/products\/add\/4\/[^\/]+\/(\d+)/) || u.match(/[?&]productId=(\d+)/) || u.match(/\/(\d{7,})(?:\/|$|\?)/);
  return m ? m[1] : null;
}

module.exports = { norm, getCategoryPT, digitosDoPreco, idProdutoDaUrl, TECH_KW, HEALTH_KW, FINANCE_KW, BUSINESS_KW };
