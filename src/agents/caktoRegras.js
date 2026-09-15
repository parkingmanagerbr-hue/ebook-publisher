'use strict';
/**
 * caktoRegras.js — decisoes puras do cadastro na Cakto, fora do navegador.
 *
 * Moravam dentro de publishToCakto (1400 linhas de Puppeteer). O publisher
 * continua chamando estas funcoes; o que muda e que agora sao testaveis.
 */

const PRECO_MINIMO = 5.00;     // minimo da Cakto
const DESC_MINIMA = 110;       // a Cakto exige 100; 110 da folga para acentuacao
const DESC_MAXIMA = 500;

/** Numero a partir de 5, "5.00", "R$ 9,90" ou "1.299,90"; NaN quando nao ha numero. */
function paraNumero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[^0-9.,]/g, '');
  if (!s.replace(/[.,]/g, '')) return NaN;
  const comCentavos = s.match(/^(.*?)[.,](\d{1,2})$/);
  if (!comCentavos) return Number(s.replace(/[.,]/g, ''));
  return Number(comCentavos[1].replace(/[.,]/g, '') || '0') + Number(comCentavos[2].padEnd(2, '0')) / 100;
}

/**
 * Preco do checkout, em texto com virgula. Nunca abaixo do minimo da Cakto.
 *
 * Era `Math.max(5, ebook.price || DEFAULT_PRICE).toFixed(2)`: preco em texto
 * com virgula ("9,90") virava NaN e o campo recebia "NaN".
 */
function precoCakto(preco, padrao) {
  const escolhido = paraNumero(preco) || paraNumero(padrao);
  return Math.max(PRECO_MINIMO, Number.isFinite(escolhido) ? escolhido : PRECO_MINIMO).toFixed(2).replace('.', ',');
}

/**
 * Descricao do produto: a Cakto recusa abaixo de 100 caracteres, entao um
 * resumo curto (ou vazio) ganha um complemento. Cortada em 500.
 */
function descricaoCakto(ebook = {}) {
  let desc = ebook.description || ebook.subtitle || '';
  if (desc.length < DESC_MINIMA) {
    const base = 'Guia completo e prático sobre ' + (ebook.topic || ebook.title || 'o tema deste e-book');
    const sufixo = '. Aprenda as melhores estratégias e técnicas com conteúdo direto ao ponto, desenvolvido para quem quer resultados reais e duradouros.';
    desc = desc ? desc + ' ' + sufixo : base + sufixo;
  }
  // slice(0,500) partia emoji ao meio (emoji ocupa duas posicoes) e mandava
  // metade de um caractere para o checkout: corta e descarta a metade solta.
  const cortada = desc.slice(0, DESC_MAXIMA);
  return /[\uD800-\uDBFF]$/.test(cortada) ? cortada.slice(0, -1) : cortada;
}

/**
 * Codigo do checkout numa URL pay.cakto.com.br/xxxxx, ou null.
 * O host faz parte da regra: sem ele, qualquer URL do painel daria "codigo"
 * (https://app.cakto.com.br/dashboard devolvia "dashboard").
 */
function codigoDoPayUrl(url) {
  const m = String(url == null ? '' : url).match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{5,})$/);
  return m ? m[1] : null;
}

/**
 * O que uma resposta da API da Cakto revela sobre o produto recem-criado:
 * { payUrl, id } quando traz o link de pagamento, { campo, id } quando so traz
 * um identificador, ou null.
 */
function lerRespostaCakto(texto) {
  const t = String(texto == null ? '' : texto);
  const pay = t.match(/pay\.cakto\.com\.br\/([A-Za-z0-9]{4,})/);
  if (pay) return { payUrl: 'https://pay.cakto.com.br/' + pay[1], id: pay[1] };
  const campo = t.match(/"(?:shortlink|shortcode|slug|checkout_url|checkoutUrl|pay_url|payUrl|payment_link|short_link)":\s*"([A-Za-z0-9_\-]{4,})"/)
    || t.match(/"(?:id|productId|product_id|uuid)":\s*"([A-Za-z0-9\-]{8,})"/);
  // Data ISO num campo "id" nao e identificador de produto.
  if (campo && !campo[1].match(/^\d{4}-\d{2}-\d{2}/)) return { campo: campo[0], id: campo[1] };
  return null;
}

module.exports = { precoCakto, descricaoCakto, codigoDoPayUrl, lerRespostaCakto, paraNumero, PRECO_MINIMO, DESC_MINIMA, DESC_MAXIMA };
