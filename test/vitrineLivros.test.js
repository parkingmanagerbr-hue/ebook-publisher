'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { montarPagina, resumo, precoBR, esc, comUrlNoSitemap } = require('../scripts/vitrineLivros');

const livro = { titulo: 'Fundo de Emergência <em 12 Meses>', descricao: 'Aprenda a montar sua reserva. Passo a passo simples para quem tem renda variável e quer segurança.', preco: 4.99, link: 'https://go.hotmart.com/I1"x', imagem: '8451111.jpg' };

test('pagina escapa titulo e link e traz preco e botao', () => {
  const html = montarPagina([livro], new Date('2026-09-16T00:00:00Z'));
  assert.ok(html.includes('Fundo de Emergência &lt;em 12 Meses&gt;'));
  assert.ok(html.includes('href="https://go.hotmart.com/I1&quot;x"'));
  assert.ok(!html.includes('<em 12 Meses>'));
  assert.ok(html.includes('R$ 4,99'));
  assert.ok(html.includes('Comprar na Hotmart'));
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
