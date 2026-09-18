'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { montarPagina, montarPaginaLivro, sitemapLivros, comSitemapNoRobots, slug, resumo, precoBR, esc, comUrlNoSitemap } = require('../scripts/vitrineLivros');

const livro = { titulo: 'Fundo de Emergência <em 12 Meses>', descricao: 'Aprenda a montar sua reserva. Passo a passo simples para quem tem renda variável e quer segurança.', preco: 4.99, link: 'https://go.hotmart.com/I1"x', imagem: '8451111.jpg' };

test('pagina escapa titulo, leva para a pagina do livro e traz preco', () => {
  const html = montarPagina([{ ...livro, slug: 'fundo-8451111' }], new Date('2026-09-16T00:00:00Z'));
  assert.ok(html.includes('Fundo de Emergência &lt;em 12 Meses&gt;'));
  assert.ok(html.includes('href="fundo-8451111/"'));
  assert.ok(!html.includes('<em 12 Meses>'));
  assert.ok(html.includes('R$ 4,99'));
  assert.ok(html.includes('atualizado em 2026-09-16'));
});

test('JSON-LD e valido, sem avaliacao inventada, e nao fecha a tag script (controle)', () => {
  const html = montarPagina([{ ...livro, titulo: 'X</script><b>' }]);
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'bloco JSON-LD presente e fechado uma vez so');
  const ld = JSON.parse(m[1]);
  assert.strictEqual(ld.itemListElement[0].item.offers.price, '4.99');
  assert.strictEqual(ld.itemListElement[0].item.name, 'X</script><b>');
  assert.ok(!/aggregateRating|review/i.test(m[1]));
});

test('resumo corta em fim de frase quando possivel', () => {
  assert.strictEqual(resumo('Curto.'), 'Curto.');
  assert.strictEqual(resumo('Primeira frase aqui. Segunda frase bem mais longa que passa do limite definido', 40), 'Primeira frase aqui.');
  assert.strictEqual(resumo('palavra '.repeat(10), 20), 'palavra palavra…');
  assert.strictEqual(resumo(null), '');
});

test('preco e escape basicos', () => {
  assert.strictEqual(precoBR(5), 'R$ 5,00');
  assert.strictEqual(precoBR(undefined), 'R$ 0,00');
  assert.strictEqual(esc(`a&b'c`), 'a&amp;b&#39;c');
  assert.strictEqual(esc(null), '');
});

test('sitemap: inclui a URL uma vez so', () => {
  const xml = '<urlset>\n</urlset>';
  const um = comUrlNoSitemap(xml, 'https://veloxisit.com.br/livros/', '2026-09-16');
  assert.ok(um.includes('<loc>https://veloxisit.com.br/livros/</loc>'));
  assert.strictEqual(comUrlNoSitemap(um, 'https://veloxisit.com.br/livros/', '2026-09-17'), um);
  assert.strictEqual(comUrlNoSitemap('', 'x', 'y'), '');
});

test('pagina sem livros nao quebra', () => {
  assert.ok(montarPagina([]).includes('<main class="grid">'));
});

test('slug: sem acento, sem simbolo, com o id no fim', () => {
  assert.strictEqual(slug('Fundo de Emergência: Guia Prático!', 8451111), 'fundo-de-emergencia-guia-pratico-8451111');
  assert.strictEqual(slug('   ', 9), 'livro-9');
  assert.strictEqual(slug(null, 9), 'livro-9');
  assert.ok(slug('a'.repeat(200), 1).length <= 62);
  assert.ok(!slug('Titulo com espaco no corte ' + 'x'.repeat(60), 7).includes('--'));
});

test('pagina do livro: canonical, dois JSON-LD validos e link de compra', () => {
  const l = { ...livro, slug: 'fundo-8451111' };
  const html = montarPaginaLivro(l, [{ slug: 'outro-1', titulo: 'Outro' }], new Date('2026-09-18T00:00:00Z'));
  assert.ok(html.includes('<link rel="canonical" href="https://veloxisit.com.br/livros/fundo-8451111/">'));
  const blocos = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.strictEqual(blocos.length, 2);
  assert.strictEqual(JSON.parse(blocos[0][1]).offers.price, '4.99');
  assert.strictEqual(JSON.parse(blocos[1][1])['@type'], 'BreadcrumbList');
  assert.ok(html.includes('href="https://go.hotmart.com/I1&quot;x"'));
  assert.ok(html.includes('<li><a href="../outro-1/">Outro</a></li>'));
  assert.ok(html.includes('atualizado em 2026-09-18'));
  assert.ok(!/aggregateRating|review/i.test(html));
});

test('pagina do livro sem descricao e sem relacionados nao quebra', () => {
  const html = montarPaginaLivro({ titulo: 'So Titulo', slug: 's-1', imagem: 'a.jpg', link: 'x', preco: 0 });
  assert.ok(html.includes('<p>So Titulo</p>'));
  assert.ok(!html.includes('Outros livros'));
  assert.ok(html.includes('R$ 0,00'));
});

test('sitemap dos livros lista a vitrine e cada pagina', () => {
  const xml = sitemapLivros([{ slug: 'a-1' }, { slug: 'b-2' }], '2026-09-18');
  assert.ok(xml.includes('<loc>https://veloxisit.com.br/livros/</loc>'));
  assert.ok(xml.includes('<loc>https://veloxisit.com.br/livros/a-1/</loc>'));
  assert.strictEqual((xml.match(/<url>/g) || []).length, 3);
  assert.ok(sitemapLivros([], '2026-09-18').includes('<urlset'));
});

test('robots ganha a linha Sitemap uma vez so', () => {
  const r = comSitemapNoRobots('User-agent: *' + String.fromCharCode(10) + 'Allow: /' + String.fromCharCode(10), 'https://x/s.xml');
  assert.ok(r.endsWith('Sitemap: https://x/s.xml' + String.fromCharCode(10)));
  assert.strictEqual(comSitemapNoRobots(r, 'https://x/s.xml'), r);
  assert.strictEqual(comSitemapNoRobots(null, 'u'), 'Sitemap: u' + String.fromCharCode(10));
});

test('cards da vitrine levam para a pagina do livro', () => {
  const html = montarPagina([{ ...livro, slug: 'fundo-8451111' }]);
  assert.ok(html.includes('href="fundo-8451111/"'));
  assert.ok(html.includes('Ver detalhes'));
});
