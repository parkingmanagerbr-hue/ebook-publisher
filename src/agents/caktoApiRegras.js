'use strict';
/**
 * caktoApiRegras.js — regras puras da publicacao na Cakto PELA API.
 *
 * Por que existe (26/09/2026): a publicacao na Cakto era feita por robo de
 * navegador (`publishBacklog --plataforma=cakto`, wizard de /products/new). O
 * wizard mudou e o robo passou a nao achar o botao "Continuar" nem o campo de
 * arquivo — 0 de 2 publicados, 3 minutos por livro, navegador pendurado. O job
 * ficou pausado no cron desde 25/09.
 *
 * Medido no mesmo dia: `POST /api/products/` cria o produto com NOME e
 * DESCRICAO apenas (HTTP 201) e a Cakto preenche o resto com padrao
 * (price 5.00, BRL, unique, 12x, garantia 7). `DELETE /api/product/{id}/`
 * remove. Com isso a publicacao deixa de depender de navegador: cria pela API
 * e completa com o mesmo PUT que a higiene ja usa.
 *
 * Tudo aqui e puro: monta corpo e decide, nao fala com a rede.
 */
const { metodosDePagamentoValidos, DESCRICAO_AFILIADO } = require('./higieneCakto');
const { PRODUTOR, COMISSAO_AFILIADO, SUPORTE } = require('./caktoIdentidade');

/** Texto de uma linha, sem quebra vinda de fora (log e nome de produto). Pura. */
function umaLinha(s, n = 60) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
}

/**
 * Nome do produto como a Cakto aceita: uma linha, no maximo 120 caracteres.
 * Titulo vazio nao vira produto — quem chama deve recusar antes. Pura.
 */
function nomeDeProduto(titulo) {
  return umaLinha(titulo, 120);
}

/**
 * Descricao do checkout. A Cakto exige o campo; texto curto demais nao
 * convence e texto gigante estoura a caixa. Pura.
 */
function descricaoDeProduto(livro) {
  const l = livro || {};
  const bruta = String(l.description || l.descricao || '').replace(/\s+/g, ' ').trim();
  if (bruta.length >= 40) return bruta.slice(0, 500);
  const titulo = umaLinha(l.title || l.titulo, 120);
  return ('E-book digital' + (titulo ? ': ' + titulo : '') +
    '. Entrega imediata por link apos a confirmacao do pagamento. Leitura em PDF, em qualquer aparelho.').slice(0, 500);
}

/**
 * Corpo do POST /api/products/. So o que a API exige — o resto entra no PUT,
 * onde ha o objeto inteiro e a validacao da loja e conhecida. Pura.
 */
function corpoDeCriacao(livro) {
  return { name: nomeDeProduto((livro || {}).title || (livro || {}).titulo), description: descricaoDeProduto(livro) };
}

/** O shortcode do checkout e o id da oferta padrao do produto. Pura. */
function shortcodeDaOferta(produto) {
  const ofertas = (produto && produto.offers) || [];
  const padrao = ofertas.find(o => o && o.default) || ofertas[0];
  return (padrao && padrao.id) || null;
}

/** Link de checkout a partir do shortcode. Pura. */
function linkDeCheckout(shortcode) {
  return shortcode ? 'https://pay.cakto.com.br/' + shortcode : null;
}

/**
 * O que gravar no produto recem-criado. Recebe o objeto que o GET devolveu e
 * devolve SO os campos a mudar (quem chama faz {...produto, ...ajustes}).
 *
 * `opcoes.entrega` e o link assinado de /entrega/:token; sem ele o produto
 * nasce SEM entrega e nao pode ficar ativo — vender sem ter o que entregar e
 * pior que nao vender (licao de 15/09/2026, 5.485 produtos sem arquivo). Pura.
 */
function corpoDeAjuste(produto, opcoes = {}) {
  const p = produto || {};
  const out = {};
  const checkout = opcoes.checkout || linkDeCheckout(shortcodeDaOferta(p));

  if (!p.producerName) out.producerName = PRODUTOR;
  if (!p.supportEmail) out.supportEmail = SUPORTE;
  if (checkout && !p.salesPage) out.salesPage = checkout;
  if (opcoes.entrega) {
    out.contentDeliveries = ['external'];
    out.emailAccessLink = opcoes.entrega;
  }
  if (!p.affiliate) {
    Object.assign(out, {
      affiliate: true, affiliateRequest: false, affiliateMarketplace: true,
      affiliateCommission: COMISSAO_AFILIADO, affiliateDescription: DESCRICAO_AFILIADO,
    });
  }
  const limpos = metodosDePagamentoValidos(p.paymentMethods, { moeda: p.currency, tipo: p.type });
  if (Array.isArray(p.paymentMethods) && limpos.length !== p.paymentMethods.length) out.paymentMethods = limpos;

  // Sem entrega o produto nao fica no ar. Com entrega, ativo.
  const temEntrega = !!(opcoes.entrega || p.emailAccessLink);
  const alvo = temEntrega ? 'active' : 'waiting_config';
  if (p.status !== alvo) out.status = alvo;

  return out;
}

/**
 * O produto que a API devolveu e mesmo o que pedimos? Guarda contra gravar
 * ajuste no produto errado — ja aconteceu na Kiwify. Pura.
 */
function mesmoProdutoCakto(nomeNaLoja, tituloPedido) {
  const n = s => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = n(nomeNaLoja);
  const b = n(nomeDeProduto(tituloPedido));
  return !!a && !!b && a === b;
}

/**
 * Motivo de nao insistir: recusa de conteudo ou limite de plano voltam iguais
 * na proxima tentativa. Devolve o motivo ou null. Pura.
 */
function motivoDefinitivo(status, corpo) {
  const t = String(corpo || '');
  const n = Number(status);
  if (n === 402 || /limite de produtos|plano nao permite|plano não permite/i.test(t)) return 'limite de plano';
  if (n === 403 && !/csrf/i.test(t)) return 'conta sem permissao';
  if (/conteudo nao permitido|conteúdo não permitido|termos de uso/i.test(t)) return 'conteudo recusado';
  return null;
}

/** Uma linha de log do que foi feito, sem dado de comprador. Pura. */
function resumoDaPublicacao(titulo, shortcode, ajustes) {
  const campos = Object.keys(ajustes || {}).sort();
  return '"' + umaLinha(titulo, 50) + '" checkout=' + umaLinha(shortcode, 20) +
    (campos.length ? ' ajustes=' + campos.join(',') : ' sem ajuste');
}

module.exports = {
  corpoDeCriacao, corpoDeAjuste, nomeDeProduto, descricaoDeProduto, shortcodeDaOferta,
  linkDeCheckout, mesmoProdutoCakto, motivoDefinitivo, resumoDaPublicacao,
  PRODUTOR, COMISSAO_AFILIADO,
};
