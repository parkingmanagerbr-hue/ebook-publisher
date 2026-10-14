'use strict';
/**
 * caktoCheckout.js — qual livro mostra o botao da Cakto na vitrine, e com que link.
 *
 * Os produtos criados pela API (desde 26/09/2026) guardam em `cakto_product_id`
 * o shortcode da oferta padrao, e https://pay.cakto.com.br/<shortcode> e o
 * checkout publico (medido em 14/10/2026: abre o livro, R$ 5,00, Pix e cartao).
 * Mas produto pausado (`waiting_config`) mostra "Produto nao encontrado" no
 * mesmo endereco — por isso o link so vale para oferta ATIVA de produto ATIVO,
 * conferido na lista da propria Cakto, e vai para a coluna `cakto_checkout`.
 *
 * Tudo aqui e puro, exceto `lerPaginado`, que so recebe o pedido por parametro.
 */

const SHORTCODE = /^[A-Za-z0-9]{4,20}$/;
/** O link que a vitrine aceita: checkout publico de UM shortcode, nada depois. */
const CHECKOUT_CAKTO = /^https:\/\/pay\.cakto\.com\.br\/[A-Za-z0-9]{4,20}$/;

/** Link publico de checkout para o shortcode, ou null. Pura. */
function urlDoCheckout(shortcode) {
  const s = String(shortcode == null ? '' : shortcode).trim();
  return SHORTCODE.test(s) ? 'https://pay.cakto.com.br/' + s : null;
}

/**
 * Le uma lista paginada da API ate o fim. A Cakto termina a paginacao com 404
 * "Pagina invalida", nao com pagina vazia. `pedir(rota)` devolve
 * { status, json }; `esperar` separa as chamadas (rajada aciona o Cloudflare e
 * derruba a sessao). Qualquer outro erro LANCA: lista pela metade nao pode virar
 * "o resto nao existe" — quem chama limparia o checkout de milhares de livros.
 */
async function lerPaginado(rota, { pedir, esperar, porPagina = 100, tetoPaginas = 1000 }) {
  const itens = [];
  let total = null;
  for (let pagina = 1; pagina <= tetoPaginas; pagina++) {
    if (pagina > 1) await esperar();
    const r = await pedir(rota + '?limit=' + porPagina + '&page=' + pagina);
    if (r.status === 404) return { itens, total };
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.results)) {
      throw new Error('CAKTO_LISTA_FALHOU: ' + rota + ' pagina ' + pagina + ' HTTP ' + r.status);
    }
    if (total == null) total = Number(r.json.count);
    itens.push(...r.json.results);
    if (!r.json.next) return { itens, total };
  }
  throw new Error('CAKTO_LISTA_SEM_FIM: ' + rota + ' passou de ' + tetoPaginas + ' paginas');
}

/**
 * A lista lida esta inteira? Produto e oferta nascem e somem durante a leitura
 * (o publicador roda em paralelo), entao exige 98% do total que a API declarou.
 * Lista curta demais nao autoriza limpar nada. Pura.
 */
function listaCompleta(lida) {
  const t = Number(lida && lida.total);
  return Number.isFinite(t) && t > 0 && lida.itens.length >= Math.floor(t * 0.98);
}

/** O que fazer com o checkout de um livro. Pura. */
function decidirCheckout(livro, ofertaPorId, statusPorProduto) {
  const oferta = ofertaPorId.get(String((livro && livro.cakto_product_id) || ''));
  if (!oferta) return { acao: 'limpar', motivo: 'sem-oferta' };
  const url = urlDoCheckout(oferta.id);
  if (!url) return { acao: 'limpar', motivo: 'shortcode-invalido' };
  if (oferta.status !== 'active') return { acao: 'limpar', motivo: 'oferta-inativa' };
  const st = statusPorProduto.get(String(oferta.product || ''));
  if (st !== 'active') return { acao: 'limpar', motivo: st ? 'produto-' + st : 'produto-ausente' };
  return { acao: 'gravar', url };
}

/**
 * Plano para o catalogo inteiro: o que muda e as contagens.
 * `livros`: [{ id, cakto_product_id, cakto_checkout }] — so os que tem cakto_product_id.
 * So entra em `mudancas` o que difere do gravado. Pura.
 */
function planejar(livros, ofertas, produtos) {
  const ofertaPorId = new Map((ofertas || []).map(o => [String(o.id), o]));
  const statusPorProduto = new Map((produtos || []).map(p => [String(p.id), p.status]));
  const resumo = { livros: 0, ativos: 0, motivos: {}, produtosAtivosSemLivro: 0, mudancas: 0 };
  const mudancas = [];
  const produtosComLivro = new Set();
  for (const l of livros || []) {
    resumo.livros++;
    const d = decidirCheckout(l, ofertaPorId, statusPorProduto);
    const oferta = ofertaPorId.get(String(l.cakto_product_id || ''));
    if (oferta) produtosComLivro.add(String(oferta.product));
    const para = d.acao === 'gravar' ? d.url : null;
    if (d.acao === 'gravar') resumo.ativos++;
    else resumo.motivos[d.motivo] = (resumo.motivos[d.motivo] || 0) + 1;
    if ((l.cakto_checkout || null) !== para) mudancas.push({ id: l.id, para });
  }
  for (const p of produtos || []) if (p.status === 'active' && !produtosComLivro.has(String(p.id))) resumo.produtosAtivosSemLivro++;
  resumo.mudancas = mudancas.length;
  return { mudancas, resumo };
}

module.exports = { CHECKOUT_CAKTO, urlDoCheckout, lerPaginado, listaCompleta, decidirCheckout, planejar };
