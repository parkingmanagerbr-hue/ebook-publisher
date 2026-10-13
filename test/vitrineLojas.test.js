'use strict';
/**
 * A vitrine so conhecia Cakto e Hotmart. A Kiwify e loja desde 22/09/2026 e o
 * Google Play esta chegando — mas so entra link que o visitante consegue usar:
 * o banco guarda da Kiwify o endereco do PAINEL do vendedor, e a Cakto sem o
 * sufixo do checkout devolve 404.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { lojasDoLivro, lojasDoCatalogo, fraseDasLojas, audiolivrosPorOriginal, elegivelParaVitrine, linkDeCompra } = require('../src/agents/vitrineRegras');
const { paginaDoLivro, paginaDoIndice, consultaDoCatalogo } = require('../scripts/vitrineCompleta');

const bom = 'Um texto de descricao com tamanho suficiente para valer a visita do leitor e do buscador, falando do que o livro entrega.';
const lojas = l => lojasDoLivro(l).map(x => x.loja + ' ' + x.url);

test('todas as lojas confiaveis, na ordem de preferencia', () => {
  const l = { gplay_id: 'AbCdEf123456', kiwify_checkout: 'https://pay.kiwify.com.br/Xy12AbC', hotmart_product_id: '8451111', cakto_sales_page: 'https://pay.cakto.com.br/abc123_1147168' };
  assert.deepStrictEqual(lojas(l), [
    'cakto https://pay.cakto.com.br/abc123_1147168',
    'hotmart https://hotmart.com/product/8451111',
    'kiwify https://pay.kiwify.com.br/Xy12AbC',
    'gplay https://play.google.com/store/books/details?id=AbCdEf123456',
  ]);
  assert.strictEqual(lojasDoLivro(l)[3].artigo, 'no', '"Comprar no Google Play"');
});

test('link incompleto ou de painel nunca vira botao', () => {
  assert.deepStrictEqual(lojas({ cakto_sales_page: 'https://pay.cakto.com.br/abc123' }), [], 'Cakto sem checkout da 404');
  assert.deepStrictEqual(lojas({ cakto_sales_page: 'https://pay.cakto.com.br/abc_1/extra' }), []);
  assert.deepStrictEqual(lojas({ kiwify_checkout: 'https://dashboard.kiwify.com/products/edit/0d1e-b6ec' }), [], 'painel do vendedor e tela de login');
  assert.deepStrictEqual(lojas({ kiwify_checkout: 'https://pay.kiwify.com.br/' }), []);
  assert.deepStrictEqual(lojas({ kiwify_checkout: 'http://pay.kiwify.com.br/Xy12' }), [], 'sem https nao');
  assert.deepStrictEqual(lojas({ kiwify_checkout: 'https://kiwify.app/Xy12' }), [], 'so o checkout pay.kiwify.com.br');
  assert.deepStrictEqual(lojas({ kiwify_checkout: 'https://pay.kiwify.com.br/Xy-12' }), [], 'id alfanumerico');
  assert.deepStrictEqual(lojas({ kiwify_url: 'https://pay.kiwify.com.br/Xy12AbC' }), [], 'kiwify_url e o painel: nunca e lido como checkout');
  assert.deepStrictEqual(lojas({ gplay_id: 'x' }), [], 'id curto demais');
  assert.deepStrictEqual(lojas({ gplay_id: 'id com espaco' }), []);
  assert.deepStrictEqual(lojas({ gplay_id: 'GGKEY:SJ22W106K4J' }), ['gplay https://play.google.com/store/books/details?id=GGKEY%3ASJ22W106K4J']);
  assert.deepStrictEqual(lojas({ hotmart_url: 'https://site-qualquer.com/x' }), []);
  assert.deepStrictEqual(lojasDoLivro(null), []);
});

test('Kiwify sozinha basta para a pagina; linkDeCompra continua so Cakto/Hotmart', () => {
  const l = { title: 'Guia', description: bom, kiwify_checkout: 'https://pay.kiwify.com.br/Xy12AbC' };
  assert.strictEqual(elegivelParaVitrine(l), true);
  assert.strictEqual(linkDeCompra(l), null, 'semantica antiga preservada');
  assert.strictEqual(elegivelParaVitrine({ ...l, kiwify_checkout: 'https://dashboard.kiwify.com/products/edit/1' }), false);
});

test('rodape so cita loja que tem produto no catalogo gerado', () => {
  const cat = [{ hotmart_product_id: '1' }, { kiwify_checkout: 'https://pay.kiwify.com.br/Aa11' }, { kiwify_checkout: 'https://dashboard.kiwify.com/x' }, null];
  assert.deepStrictEqual(lojasDoCatalogo(cat), ['Hotmart', 'Kiwify']);
  assert.deepStrictEqual(lojasDoCatalogo([{ gplay_id: 'AbCdEf1234' }, { cakto_sales_page: 'https://pay.cakto.com.br/a_1' }]), ['Cakto', 'Google Play'], 'ordem da lista, nao da chegada');
  assert.deepStrictEqual(lojasDoCatalogo(null), []);
  assert.strictEqual(fraseDasLojas(['Hotmart']), 'Disponível na Hotmart');
  assert.strictEqual(fraseDasLojas(['Hotmart', 'Cakto', 'Kiwify', 'Google Play']), 'Disponível na Hotmart, Cakto, Kiwify e Google Play');
  assert.strictEqual(fraseDasLojas([]), '');
  assert.strictEqual(fraseDasLojas(null), '');
});

test('cada original aponta para o audiolivro que esta na vitrine', () => {
  const m = audiolivrosPorOriginal([{ id: 'a1', audio_de: 'o1' }, { id: 'o1' }, { id: 'a2', audio_de: 'o1' }, null]);
  assert.strictEqual(m.get('o1').id, 'a1', 'o primeiro fica');
  assert.strictEqual(m.size, 1);
  assert.strictEqual(audiolivrosPorOriginal(null).size, 0);
});

const livro = (extra = {}) => ({
  id: 'o1', title: 'Liderança Prática', description: bom, price: 4.99, slug: 'lideranca-pratica-o1', imagem: null,
  lojas: lojasDoLivro({ hotmart_product_id: '845', kiwify_checkout: 'https://pay.kiwify.com.br/Kw11' }), ...extra,
});

test('pagina do livro: um botao por loja, o primeiro destacado, e o bloco do audiolivro', () => {
  const audio = { slug: 'lideranca-pratica-audiolivro-a1', title: 'Liderança Prática + Audiolivro', price: 9.9 };
  const h = paginaDoLivro(livro(), [], { audio, lojas: 'Disponível na Hotmart e Kiwify' });
  assert.match(h, /<a class="botao" href="https:\/\/hotmart\.com\/product\/845"[^>]*>Comprar na Hotmart<\/a>/);
  assert.match(h, /<a class="botao secundario" href="https:\/\/pay\.kiwify\.com\.br\/Kw11"[^>]*>Comprar na Kiwify<\/a>/);
  assert.match(h, /Também com audiolivro[\s\S]*href="\/livros\/lideranca-pratica-audiolivro-a1\/"/);
  assert.match(h, /R\$ 9,90/);
  assert.match(h, /Disponível na Hotmart e Kiwify/);
  assert.match(h, /"bookFormat":"https:\/\/schema.org\/EBook"/);
  assert.match(h, /"url":"https:\/\/hotmart\.com\/product\/845"/, 'oferta aponta para a loja principal');
  assert.ok(!/avalia|vendid|estrela/i.test(h), 'nada de prova social');

  const sem = paginaDoLivro(livro(), []);
  assert.ok(!/Também com audiolivro/.test(sem), 'sem audiolivro, sem bloco');
  assert.ok(!/Disponível na/.test(sem));
});

test('pagina do audiolivro diz os dois formatos, e o JSON-LD tambem', () => {
  const h = paginaDoLivro(livro({ audio_de: 'o0', price: 9.9, title: 'Liderança Prática + Audiolivro' }), []);
  assert.match(h, /e-book em PDF \+ audiolivro em MP3/);
  assert.match(h, /"bookFormat":\["https:\/\/schema.org\/EBook","https:\/\/schema.org\/AudiobookFormat"\]/);
  assert.match(h, /class="selo">com audiolivro/);
});

test('indice: selo "com audiolivro" no audiolivro e no original que tem um', () => {
  const itens = [livro({ id: 'o1' }), livro({ id: 'a1', audio_de: 'o1', slug: 's-a1' }), livro({ id: 'o2', slug: 's-o2' })];
  const h = paginaDoIndice(itens, { numero: 1, total: 1, idioma: null, lojas: 'Disponível na Hotmart', comAudio: new Map([['o1', itens[1]]]) });
  assert.strictEqual((h.match(/class="selo">com audiolivro/g) || []).length, 2);
  assert.match(h, /Disponível na Hotmart/);
  assert.strictEqual((paginaDoIndice(itens, { numero: 1, total: 1 }).match(/class="selo"/g) || []).length, 1, 'sem mapa, so o proprio audiolivro');
});

test('consulta do catalogo tolera coluna ausente (gplay_id ainda nao existe)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, title TEXT, description TEXT, language TEXT, price REAL, cover_path TEXT, ' +
    'hotmart_product_id TEXT, hotmart_url TEXT, cakto_product_id TEXT, kiwify_checkout TEXT)');
  db.prepare("INSERT INTO ebooks (id, title, kiwify_checkout) VALUES ('k', 'So Kiwify', 'https://pay.kiwify.com.br/Aa11')").run();
  db.prepare("INSERT INTO ebooks (id, title) VALUES ('n', 'Em loja nenhuma')").run();
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  const linhas = db.prepare(consultaDoCatalogo(cols)).all();
  assert.deepStrictEqual(linhas.map(l => l.id), ['k'], 'Kiwify sozinha entra na consulta');
  assert.strictEqual(linhas[0].gplay_id, null);
  assert.strictEqual(linhas[0].audio_de, null);
  assert.match(consultaDoCatalogo([]), / WHERE 0$/, 'sem coluna de loja, nada');
});
