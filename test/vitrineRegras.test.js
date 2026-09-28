'use strict';
/**
 * vitrineRegras: a vitrine tinha 23 paginas para 13.700 produtos. Ao abri-la
 * para o catalogo inteiro, duas regras nao podem ser afrouxadas: nunca mandar
 * o visitante para um link quebrado, e nunca publicar pagina sem texto proprio.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { linkDeCompra, elegivelParaVitrine, slugDoLivro, paginasDoIndice, lotesDeSitemap, porIdioma } = require('../src/agents/vitrineRegras');

const bom = 'Um texto de descricao com tamanho suficiente para valer a visita do leitor e do buscador, falando do que o livro entrega.';

test('checkout da Cakto COMPLETO tem preferencia (e compra direta)', () => {
  const l = { cakto_sales_page: 'https://pay.cakto.com.br/abc123_1147168', hotmart_product_id: '8451111' };
  assert.strictEqual(linkDeCompra(l), 'https://pay.cakto.com.br/abc123_1147168');
});

test('link da Cakto SEM o id do checkout nunca vai para o ar', () => {
  // pay.cakto.com.br/<shortcode> devolve "404 — Produto nao disponivel".
  const l = { cakto_sales_page: 'https://pay.cakto.com.br/abc123', hotmart_product_id: '8451111' };
  assert.strictEqual(linkDeCompra(l), 'https://hotmart.com/product/8451111', 'cai para a Hotmart em vez do 404');
  assert.strictEqual(linkDeCompra({ cakto_sales_page: 'https://pay.cakto.com.br/abc123' }), null, 'sem alternativa, nao ha link');
});

test('sem link nenhum, o livro nao vira pagina', () => {
  assert.strictEqual(linkDeCompra({}), null);
  assert.strictEqual(linkDeCompra(null), null);
  assert.strictEqual(linkDeCompra({ hotmart_product_id: 'nao-e-numero' }), null);
  assert.strictEqual(linkDeCompra({ hotmart_url: 'https://site-qualquer.com/x' }), null, 'so dominio da loja');
  assert.strictEqual(linkDeCompra({ hotmart_url: 'https://go.hotmart.com/E107456833M' }), 'https://go.hotmart.com/E107456833M');
});

test('pagina sem texto proprio e conteudo raso: fica de fora', () => {
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', description: 'curto', hotmart_product_id: '1' }), false);
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', description: bom, hotmart_product_id: '1' }), true);
  assert.strictEqual(elegivelParaVitrine({ title: '', description: bom, hotmart_product_id: '1' }), false);
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', description: bom }), false, 'sem link nao entra');
  assert.strictEqual(elegivelParaVitrine(null), false);
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', description: bom, hotmart_product_id: '1' }, { minimoDescricao: 500 }), false);
});

test('capa nao e obrigatoria: a pagina funciona sem imagem', () => {
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', description: bom, hotmart_product_id: '1', cover_path: null }), true);
});

test('o endereco da pagina e estavel e nao colide entre livros de mesmo nome', () => {
  assert.strictEqual(slugDoLivro('Ganhe Dinheiro com IA em 2026', 'abc12345678'), 'ganhe-dinheiro-com-ia-em-2026-12345678');
  const a = slugDoLivro('Mesmo Titulo', 'id-aaaa1111');
  const b = slugDoLivro('Mesmo Titulo', 'id-bbbb2222');
  assert.notStrictEqual(a, b, 'o id no fim separa homonimos');
  assert.strictEqual(slugDoLivro('Ação & Café: Guia!', '1'), 'acao-cafe-guia-1', 'sem acento nem pontuacao');
  assert.strictEqual(slugDoLivro('', 'xyz'), 'xyz');
  assert.strictEqual(slugDoLivro('', ''), null, 'sem titulo e sem id nao ha endereco');
  assert.strictEqual(slugDoLivro(null, null), null);
  assert.ok(!slugDoLivro('T'.repeat(200), '9').startsWith('-'));
});

test('o indice e paginado: milhares de itens numa pagina so nao se navega', () => {
  const cem = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const p = paginasDoIndice(cem, 60);
  assert.strictEqual(p.length, 2);
  assert.strictEqual(p[0].length, 60);
  assert.strictEqual(p[1].length, 40);
  assert.deepStrictEqual(paginasDoIndice([], 60), [[]], 'sempre ha uma pagina, nem que vazia');
  assert.deepStrictEqual(paginasDoIndice(null), [[]]);
  assert.strictEqual(paginasDoIndice(cem, 0).length, 2, 'tamanho invalido cai no padrao');
});

test('o sitemap respeita o limite do protocolo', () => {
  const muitos = Array.from({ length: 25000 }, (_, i) => 'https://x/' + i);
  const lotes = lotesDeSitemap(muitos);
  assert.strictEqual(lotes.length, 3);
  assert.strictEqual(lotes[0].length, 10000);
  assert.strictEqual(lotes[2].length, 5000);
  assert.ok(lotesDeSitemap(muitos, 99999)[0].length <= 50000, 'nunca passa de 50.000 por arquivo');
  assert.deepStrictEqual(lotesDeSitemap([]), []);
  assert.deepStrictEqual(lotesDeSitemap(null), []);
});

test('agrupar por idioma usa as duas primeiras letras', () => {
  const m = porIdioma([{ language: 'pt-BR' }, { language: 'pt' }, { language: 'en-US' }, { idioma: 'JA' }, {}]);
  assert.strictEqual(m.get('pt').length, 3, 'pt-BR, pt e o sem idioma (padrao pt)');
  assert.strictEqual(m.get('en').length, 1);
  assert.strictEqual(m.get('ja').length, 1);
  assert.strictEqual(porIdioma(null).size, 0);
});

test('titulo so de simbolos cai no id; livro sem descricao util nao entra', () => {
  assert.strictEqual(slugDoLivro('!!! ???', 'abc99999999'), '99999999');
  assert.strictEqual(slugDoLivro('Guia', null), 'guia', 'sem id, so o titulo');
  assert.strictEqual(elegivelParaVitrine({ title: 'Guia', hotmart_product_id: '1' }), false, 'sem descricao nenhuma');
});

test('tamanho de sitemap invalido cai no padrao, nunca em zero', () => {
  const dez = Array.from({ length: 10 }, (_, i) => 'https://x/' + i);
  assert.strictEqual(lotesDeSitemap(dez, 0).length, 1, 'zero viraria laco infinito');
  assert.strictEqual(lotesDeSitemap(dez, 'abc').length, 1);
  assert.strictEqual(lotesDeSitemap(dez, -3)[0].length, 10);
});
