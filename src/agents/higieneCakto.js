'use strict';
/**
 * higieneCakto.js — o que consertar no catalogo da Cakto sem depender do PDF.
 *
 * Auditoria de 23/09/2026 (8.000 produtos lidos pela API):
 *   - 8.000 sem `producerName`: o checkout mostrava "Termos de uso de
 *     <e-mail pessoal do dono>". Comprador desconfia e o e-mail vaza.
 *   - 5.768 sem imagem: checkout so com o titulo.
 *   - 8.000 sem afiliacao: ninguem podia divulgar em troca de comissao.
 *   - 5.485 em `waiting_config` por falta de PDF (conserto e outro: regerar).
 *
 * O job de entrega (entregaCakto.js) so toca em quem ja tem PDF; por isso a
 * maior parte do catalogo nunca foi corrigida. Aqui a regra vale para TODOS,
 * inclusive os pausados — sem mexer em `status`: produto sem arquivo continua
 * pausado, porque vender sem ter o que entregar e pior que nao vender.
 */
const { PRODUTOR, COMISSAO_AFILIADO } = require('../../scripts/entregaCakto');

const DESCRICAO_AFILIADO = 'E-book digital com entrega imediata por link. Comissão de ' + COMISSAO_AFILIADO +
  '% em cada venda aprovada, afiliação automática. Divulgue de forma honesta, sem prometer resultado.';

/** Pagina de vendas errada: vazia ou apontando para outra plataforma. Pura. */
function paginaDeVendasRuim(url) {
  const u = String(url || '').trim();
  return !u || /^https?:\/\/(www\.)?hotmart\.com\/?$/i.test(u);
}

/**
 * O que gravar neste produto. Devolve {} quando nao ha nada a fazer. Pura.
 * `opcoes.checkout` e o link do proprio produto; `opcoes.temCapa` diz se ha
 * imagem para enviar (o envio em si e multipart, feito por quem chama).
 */
function alvoHigiene(produto, opcoes = {}) {
  const p = produto || {};
  const out = {};
  // A API devolve metodos que ela mesma recusa: limpar antes de devolver.
  const limpos = metodosDePagamentoValidos(p.paymentMethods, { moeda: p.currency, tipo: p.type });
  if (Array.isArray(p.paymentMethods) && limpos.length !== p.paymentMethods.length) out.paymentMethods = limpos;
  if (!p.producerName) out.producerName = PRODUTOR;
  if (opcoes.checkout && paginaDeVendasRuim(p.salesPage)) out.salesPage = opcoes.checkout;
  if (!p.affiliate) {
    Object.assign(out, { affiliate: true, affiliateRequest: false, affiliateMarketplace: true });
    const atual = Number(p.affiliateCommission);
    // A Cakto so aceita 1% a 95%: "0.00" gravado derrubava o PUT inteiro (400).
    if (p.affiliateCommission == null || !(atual >= 1 && atual <= 95)) out.affiliateCommission = COMISSAO_AFILIADO;
    if (!p.affiliateDescription) out.affiliateDescription = DESCRICAO_AFILIADO;
  }
  return out;
}

/**
 * Metodos de pagamento que a Cakto aceita de volta no PUT.
 *
 * 23/09/2026: a propria API DEVOLVE metodos que ela recusa na gravacao, e o
 * PUT inteiro falhava com 400 — parando a higiene (60 de 60) e a correcao de
 * entrega do catalogo:
 *   "Metodos de pagamento invalidos para a moeda BRL: spei, oxxo"
 *   "O metodo de pagamento Pix Automatico nao e permitido para produtos sem assinatura"
 * Pura.
 */
const SO_MEXICO = new Set(['spei', 'oxxo']);
const SO_ASSINATURA = new Set(['pix_auto']);
function metodosDePagamentoValidos(metodos, { moeda = 'BRL', tipo = 'unique' } = {}) {
  const lista = Array.isArray(metodos) ? metodos : [];
  return lista.filter(m => {
    const nome = String(m || '').toLowerCase();
    if (!nome) return false;
    if (String(moeda).toUpperCase() === 'BRL' && SO_MEXICO.has(nome)) return false;
    if (String(tipo).toLowerCase() !== 'subscription' && SO_ASSINATURA.has(nome)) return false;
    return true;
  });
}

/** Precisa subir imagem? So quando o produto nao tem e existe capa em disco. Pura. */
function precisaSubirCapa(produto, capaExiste) {
  return !!capaExiste && !(produto && produto.image);
}

/** Uma linha de resumo para o log, sem dado de comprador. Pura. */
function resumoDaCorrecao(produtoId, mudancas, subiuCapa) {
  const campos = Object.keys(mudancas || {}).sort();
  const id = String(produtoId == null ? '' : produtoId).replace(/[\r\n\t]+/g, ' ').slice(0, 40);
  if (!campos.length && !subiuCapa) return id + ': nada a corrigir';
  return id + ': ' + [...(subiuCapa ? ['capa'] : []), ...campos].join(', ');
}

module.exports = { alvoHigiene, precisaSubirCapa, paginaDeVendasRuim, resumoDaCorrecao, metodosDePagamentoValidos, DESCRICAO_AFILIADO };
