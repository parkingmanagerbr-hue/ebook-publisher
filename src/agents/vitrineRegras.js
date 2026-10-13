'use strict';
/**
 * vitrineRegras.js — quem entra na vitrine publica e com que link.
 *
 * Ate 28/09/2026 a vitrine tinha 23 paginas para um catalogo de 13.700
 * produtos: ela so publicava os livros marcados como "destaque". Sem pagina
 * publica, o produto so existe para quem ja esta dentro do marketplace — e o
 * afiliado nao tem o que divulgar.
 *
 * Regras de conteudo publico do playbook valem aqui: nada de avaliacao,
 * contagem de vendas ou "mais vendido". So o que e do proprio livro (titulo,
 * descricao, preco) e o link oficial de compra.
 *
 * Tudo puro.
 */

/** Uma linha, sem quebra e sem espaco duplo. */
function umaLinha(s, n = 300) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}

/**
 * O link de compra do livro, ou null quando nao ha nenhum confiavel.
 *
 * A Cakto vem primeiro quando o link esta COMPLETO (`<oferta>_<checkout>`):
 * e checkout direto, uma tela ate o pagamento. Link da Cakto sem o sufixo
 * devolve "404 — Produto nao disponivel" e NAO pode ir para o ar (era o estado
 * de 10.648 produtos ate 27/09/2026). Pura.
 */
function linkDeCompra(livro) {
  const l = livro || {};
  return linkCakto(l) || linkHotmart(l);
}

function linkCakto(l) {
  const cakto = umaLinha(l.cakto_sales_page || l.caktoSalesPage, 300);
  return /^https:\/\/pay\.cakto\.com\.br\/[^/?#]*_[^/?#]+$/.test(cakto) ? cakto : null;
}

function linkHotmart(l) {
  const hm = umaLinha(l.hotmart_product_id || l.hotmartProductId, 40);
  if (/^\d+$/.test(hm)) return 'https://hotmart.com/product/' + hm;
  const url = umaLinha(l.hotmart_url || l.hotmartUrl, 300);
  return /^https:\/\/(go\.)?hotmart\.com\//.test(url) ? url : null;
}

/**
 * Kiwify: so o checkout publico. O banco guarda em `kiwify_url` o endereco do
 * PAINEL do vendedor (dashboard.kiwify.com/products/edit/<id>, medido em
 * 13/10/2026 nos 1.419 livros de la) — o visitante cairia numa tela de login.
 * Esse endereco e recusado; entra so quem tiver o link de compra de verdade.
 */
function linkKiwify(l) {
  const url = umaLinha(l.kiwify_url || l.kiwifyUrl, 300);
  return /^https:\/\/(pay\.kiwify\.com\.br|kiwify\.app)\/[A-Za-z0-9_-]+\/?$/.test(url) ? url : null;
}

/**
 * Google Play Livros: `gplay_id` e o identificador do livro na loja.
 * CONFIRMAR no primeiro livro publicado la: a pagina publica e
 * play.google.com/store/books/details?id=<id do volume>. O Partner Center
 * mostra tambem um "GGKEY:..." para livro sem ISBN, e nao ha medicao aqui de
 * que a pagina publica aceite esse valor — se o botao "Comprar no Google Play"
 * abrir "item nao encontrado", e este id que precisa trocar pelo do volume.
 */
function linkGooglePlay(l) {
  const id = umaLinha(l.gplay_id || l.gplayId, 80);
  if (!/^(GGKEY:)?[A-Za-z0-9_-]{6,60}$/.test(id)) return null;
  return 'https://play.google.com/store/books/details?id=' + encodeURIComponent(id);
}

/** Nome da loja na frase ("Comprar na Hotmart", "no Google Play"). */
const LOJAS = [
  { loja: 'cakto', nome: 'Cakto', artigo: 'na', link: linkCakto },
  { loja: 'hotmart', nome: 'Hotmart', artigo: 'na', link: linkHotmart },
  { loja: 'kiwify', nome: 'Kiwify', artigo: 'na', link: linkKiwify },
  { loja: 'gplay', nome: 'Google Play', artigo: 'no', link: linkGooglePlay },
];

/**
 * Todas as lojas onde o livro pode ser comprado, so com link confiavel, na
 * ordem de preferencia (a Cakto completa e checkout direto; a primeira e o
 * botao principal da pagina). Pura.
 */
function lojasDoLivro(livro) {
  const l = livro || {};
  const out = [];
  for (const d of LOJAS) {
    const url = d.link(l);
    if (url) out.push({ loja: d.loja, nome: d.nome, artigo: d.artigo, url });
  }
  return out;
}

/**
 * Nomes das lojas que tem ao menos um livro no catalogo GERADO, na ordem da
 * lista. O rodape so cita loja com produto: prometer uma loja onde o visitante
 * nao acha nada e propaganda enganosa. Pura.
 */
function lojasDoCatalogo(livros) {
  const presentes = new Set();
  for (const l of (livros || []).filter(Boolean)) for (const x of lojasDoLivro(l)) presentes.add(x.loja);
  return LOJAS.filter(d => presentes.has(d.loja)).map(d => d.nome);
}

/** "Disponível na Hotmart, Cakto e Kiwify"; vazio sem loja nenhuma. Pura. */
function fraseDasLojas(nomes) {
  const n = (nomes || []).filter(Boolean);
  if (!n.length) return '';
  const lista = n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' e ' + n[n.length - 1];
  return 'Disponível na ' + lista;
}

/**
 * Liga cada livro original ao seu "e-book + audiolivro" que esta NA VITRINE
 * (lista ja filtrada): o bloco "Também com audiolivro" so aponta para pagina
 * que existe. Pura.
 */
function audiolivrosPorOriginal(livros) {
  const mapa = new Map();
  for (const l of (livros || []).filter(Boolean)) {
    const de = umaLinha(l.audio_de, 80);
    if (de && !mapa.has(de)) mapa.set(de, l);
  }
  return mapa;
}

/**
 * O livro pode virar pagina publica?
 *
 * Exige link de compra em alguma loja (Kiwify sozinha conta) e uma descricao que valha a visita — pagina sem texto
 * proprio e conteudo raso, e milhares delas prejudicam o site inteiro em vez
 * de ajudar. Capa nao e obrigatoria (a pagina funciona sem imagem), mas entra
 * quando existe. Pura.
 */
function elegivelParaVitrine(livro, { minimoDescricao = 120 } = {}) {
  const l = livro || {};
  if (!umaLinha(l.title || l.titulo, 200)) return false;
  if (!lojasDoLivro(l).length) return false;
  return umaLinha(l.description || l.descricao, 5000).length >= minimoDescricao;
}

/** Endereco da pagina: titulo em minusculas, sem acento, com o id no fim. Pura. */
function slugDoLivro(titulo, id) {
  const base = String(titulo == null ? '' : titulo)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    .replace(/-+$/, '');
  const sufixo = String(id == null ? '' : id).replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  if (!base) return sufixo || null;
  return sufixo ? base + '-' + sufixo : base;
}

/**
 * Divide a lista em paginas de indice. Uma pagina com milhares de itens nao e
 * navegavel nem para gente nem para robo de busca. Pura.
 */
function paginasDoIndice(livros, porPagina = 60) {
  const lista = (livros || []).filter(Boolean);
  const tamanho = Math.max(1, Number(porPagina) || 60);
  const paginas = [];
  for (let i = 0; i < lista.length; i += tamanho) paginas.push(lista.slice(i, i + tamanho));
  return paginas.length ? paginas : [[]];
}

/**
 * Divide as URLs em arquivos de sitemap. O limite do protocolo e 50.000 por
 * arquivo; 10.000 deixa folga e mantem cada arquivo leve. Pura.
 */
function lotesDeSitemap(urls, porArquivo = 10000) {
  const lista = (urls || []).filter(Boolean);
  // Valor invalido (zero, negativo, texto) cai no padrao: -3 aqui geraria um
  // arquivo de sitemap POR URL, que e pior que o erro original.
  const pedido = Number(porArquivo);
  const tamanho = Math.min(50000, pedido > 0 ? pedido : 10000);
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

/** Agrupa por idioma para o indice ficar navegavel. Pura. */
function porIdioma(livros) {
  const mapa = new Map();
  for (const l of (livros || []).filter(Boolean)) {
    const k = String((l.language || l.idioma || 'pt') + '').slice(0, 2).toLowerCase();
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(l);
  }
  return mapa;
}

module.exports = { linkDeCompra, lojasDoLivro, lojasDoCatalogo, fraseDasLojas, audiolivrosPorOriginal, elegivelParaVitrine, slugDoLivro, paginasDoIndice, lotesDeSitemap, porIdioma, umaLinha };
