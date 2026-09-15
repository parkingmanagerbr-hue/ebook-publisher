'use strict';
/**
 * Entidades e servico de dominio da publicacao.
 *
 * O que importa aqui e a decisao "este e-book ja esta nesta loja?". Errar para
 * "nao esta" vira produto duplicado na loja (ja aconteceu no Hotmart); errar
 * para "esta" deixa e-book pronto parado para sempre.
 */
const test = require('node:test');
const assert = require('node:assert');

const { Ebook } = require('../src/domain/entities/Ebook');
const { Publication } = require('../src/domain/entities/Publication');
const { IEbookRepository } = require('../src/domain/repositories/IEbookRepository');
const { PublishingDomainService } = require('../src/domain/services/PublishingDomainService');

// ── Ebook ───────────────────────────────────────────────────────────────────

test('Ebook sem dados opcionais recebe os padroes (preco 4,99, pendente, id gerado)', () => {
  const e = new Ebook({ topic: 't', title: 'Titulo' });
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(e.price, 4.99);
  assert.strictEqual(e.status, 'pending');
  assert.strictEqual(e.subtitle, '');
  assert.strictEqual(e.description, '');
  assert.strictEqual(e.coverPath, null);
  assert.strictEqual(e.pdfPath, null);
  assert.strictEqual(e.salesCount, 0);
  assert.strictEqual(e.revenue, 0);
  assert.strictEqual(e.aiProvider, null);
  assert.ok(!Number.isNaN(Date.parse(e.createdAt)));
  assert.strictEqual(e.publishedAt, null);
  assert.strictEqual(e.publishedCount(), 0);
});

test('preco zero e mantido — so preco AUSENTE vira 4,99', () => {
  // `price || 4.99` transformaria e-book gratuito em pago; aqui o teste e typeof.
  assert.strictEqual(new Ebook({ price: 0 }).price, 0);
  assert.strictEqual(new Ebook({ price: '9.90' }).price, 4.99, 'texto nao e preco valido');
});

test('Ebook aceita ids de loja em camelCase e em snake_case', () => {
  const camel = new Ebook({ id: 'x', subtitle: 's', description: 'd', coverPath: 'c', pdfPath: 'p', status: 'ready',
    salesCount: 2, revenue: 9.98, aiProvider: 'groq', createdAt: '2026-01-01', publishedAt: '2026-01-02',
    hotmartProductId: 'H', hotmartUrl: 'hu', caktoProductId: 'C', caktoUrl: 'cu', amazonAsin: 'A', amazonUrl: 'au' });
  assert.deepStrictEqual([camel.id, camel.subtitle, camel.description, camel.coverPath, camel.pdfPath, camel.status,
    camel.salesCount, camel.revenue, camel.aiProvider, camel.createdAt, camel.publishedAt],
    ['x', 's', 'd', 'c', 'p', 'ready', 2, 9.98, 'groq', '2026-01-01', '2026-01-02']);
  assert.deepStrictEqual([camel.hotmartProductId, camel.hotmartUrl, camel.caktoProductId, camel.caktoUrl, camel.amazonAsin, camel.amazonUrl],
    ['H', 'hu', 'C', 'cu', 'A', 'au']);

  const snake = new Ebook({ hotmart_product_id: 'H', hotmart_url: 'hu', cakto_product_id: 'C', cakto_url: 'cu', amazon_asin: 'A', amazon_url: 'au' });
  assert.deepStrictEqual([snake.hotmartProductId, snake.hotmartUrl, snake.caktoProductId, snake.caktoUrl, snake.amazonAsin, snake.amazonUrl],
    ['H', 'hu', 'C', 'cu', 'A', 'au']);
});

test('ASIN da Amazon cai para o antigo product_id nas duas grafias, e o alias acompanha', () => {
  assert.strictEqual(new Ebook({ amazonProductId: 'P1' }).amazonAsin, 'P1');
  const e = new Ebook({ amazon_product_id: 'P2' });
  assert.strictEqual(e.amazonAsin, 'P2');
  assert.strictEqual(e.amazonProductId, 'P2');
  assert.strictEqual(new Ebook({}).amazonAsin, null);
});

test('pronto para publicar exige PDF e status ready/pending', () => {
  assert.strictEqual(new Ebook({ pdfPath: '/a.pdf', status: 'ready' }).isReadyForPublishing(), true);
  assert.strictEqual(new Ebook({ pdfPath: '/a.pdf' }).isReadyForPublishing(), true);
  assert.strictEqual(new Ebook({ status: 'ready' }).isReadyForPublishing(), false, 'sem PDF nao publica');
  assert.strictEqual(new Ebook({ pdfPath: '/a.pdf', status: 'publishing' }).isReadyForPublishing(), false);
  assert.strictEqual(new Ebook({ pdfPath: '/a.pdf', status: 'error' }).isReadyForPublishing(), false);
});

test('isPublishedOn e pendingPlatforms por loja; loja desconhecida nunca conta como publicada', () => {
  const e = new Ebook({ hotmartProductId: '8419956' });
  assert.strictEqual(e.isPublishedOn('hotmart'), true);
  assert.strictEqual(e.isPublishedOn('cakto'), false);
  assert.strictEqual(e.isPublishedOn('amazon'), false);
  assert.strictEqual(e.isPublishedOn('shopee'), false);
  assert.deepStrictEqual(e.pendingPlatforms(), ['cakto']);
  assert.deepStrictEqual(e.pendingPlatforms(['hotmart', 'amazon']), ['amazon']);
  assert.deepStrictEqual(new Ebook({ amazonAsin: 'B0X' }).pendingPlatforms(['amazon']), []);
});

test('markPublished grava a loja certa, muda status e preserva a primeira data de publicacao', () => {
  const e = new Ebook({ status: 'ready' });
  e.markPublished('hotmart', 'H1', 'https://h');
  assert.deepStrictEqual([e.hotmartProductId, e.hotmartUrl, e.status], ['H1', 'https://h', 'published']);
  const primeira = e.publishedAt;
  assert.ok(primeira);

  e.publishedAt = '2020-01-01T00:00:00.000Z';
  e.markPublished('cakto', 'C1', 'https://c');
  assert.deepStrictEqual([e.caktoProductId, e.caktoUrl], ['C1', 'https://c']);
  assert.strictEqual(e.publishedAt, '2020-01-01T00:00:00.000Z', 'segunda loja nao reescreve a data');

  e.markPublished('amazon', 'B0AB', 'https://a');
  assert.deepStrictEqual([e.amazonAsin, e.amazonProductId, e.amazonUrl], ['B0AB', 'B0AB', 'https://a']);
  assert.strictEqual(e.publishedCount(), 3);
});

test('markPublished com loja desconhecida nao marca publicado (controle negativo)', () => {
  const e = new Ebook({ status: 'ready' });
  e.markPublished('shopee', 'S1', 'u');
  assert.strictEqual(e.status, 'ready');
  assert.strictEqual(e.publishedAt, null);
});

test('markError guarda a mensagem e muda o status', () => {
  const e = new Ebook({});
  e.markError('PDF corrompido');
  assert.strictEqual(e.status, 'error');
  assert.strictEqual(e.lastError, 'PDF corrompido');
});

test('toJSON leva ids de loja e a contagem de publicacoes', () => {
  const j = new Ebook({ id: 'i', topic: 't', title: 'T', hotmartProductId: 'H', amazonAsin: 'A' }).toJSON();
  assert.strictEqual(j.id, 'i');
  assert.strictEqual(j.hotmartProductId, 'H');
  assert.strictEqual(j.amazonProductId, 'A');
  assert.strictEqual(j.publishedCount, 2);
  assert.ok(['title', 'price', 'caktoUrl', 'amazonUrl', 'publishedAt'].every(k => k in j));
});

test('fromDbRow converte snake_case e usa amazon_product_id quando nao ha amazon_asin', () => {
  const row = { id: 'r', topic: 't', title: 'T', subtitle: 's', description: 'd', cover_path: 'c', pdf_path: 'p',
    status: 'ready', price: 7.9, sales_count: 3, revenue: 12, ai_provider: 'gemini', created_at: '2026-02-01',
    published_at: null, hotmart_product_id: 'H', hotmart_url: 'hu', cakto_product_id: null, cakto_url: null,
    amazon_asin: null, amazon_product_id: 'OLD', amazon_url: 'au' };
  const e = Ebook.fromDbRow(row);
  assert.deepStrictEqual([e.coverPath, e.pdfPath, e.price, e.salesCount, e.aiProvider, e.hotmartProductId, e.amazonAsin],
    ['c', 'p', 7.9, 3, 'gemini', 'H', 'OLD']);
  assert.strictEqual(Ebook.fromDbRow({ ...row, amazon_asin: 'NEW' }).amazonAsin, 'NEW');
  assert.strictEqual(Ebook.fromDbRow({ ...row, price: null }).price, 4.99, 'preco NULL no banco vira o padrao');
});

// ── Publication ─────────────────────────────────────────────────────────────

test('Publication recusa loja invalida e e imutavel', () => {
  assert.throws(() => new Publication('shopee'), /Invalid platform: shopee/);
  const p = Publication.pending('cakto');
  assert.ok(Object.isFrozen(p));
  assert.deepStrictEqual(p.toJSON(), { platform: 'cakto', productId: null, url: null, publishedAt: null, status: 'pending' });
  assert.strictEqual(new Publication('amazon').status, 'pending');
});

test('Publication ativa so com status publicado E id de produto', () => {
  const p = Publication.pending('hotmart');
  assert.deepStrictEqual([p.isPending(), p.isActive(), p.isFailed()], [true, false, false]);
  const ok = p.withSuccess('H1', 'u');
  assert.notStrictEqual(ok, p, 'nova instancia, original intacto');
  assert.strictEqual(p.status, 'pending');
  assert.deepStrictEqual([ok.isActive(), ok.productId, ok.url], [true, 'H1', 'u']);
  assert.ok(ok.publishedAt);
  assert.strictEqual(new Publication('hotmart', null, null, null, 'published').isActive(), false, 'publicado sem id nao e ativo');

  const falhou = ok.withFailure();
  assert.deepStrictEqual([falhou.isFailed(), falhou.isActive(), falhou.productId, falhou.publishedAt], [true, false, 'H1', ok.publishedAt]);
});

// ── IEbookRepository ────────────────────────────────────────────────────────

test('contrato do repositorio: todo metodo nao implementado rejeita', async () => {
  const r = new IEbookRepository();
  for (const [m, args] of [['findById', ['x']], ['findAll', []], ['findPendingForPlatform', ['hotmart']],
    ['save', [{}]], ['markPublished', ['x', 'hotmart', 'p', 'u']], ['getStats', []]]) {
    await assert.rejects(() => r[m](...args), /Not implemented/, m);
  }
});

// ── PublishingDomainService ─────────────────────────────────────────────────

const svc = new PublishingDomainService();

test('filterNeedsPublishing ignora sem PDF e ja publicado em todas as lojas-alvo', () => {
  const semPdf = new Ebook({ id: '1', title: 'Sem PDF' });
  const completo = new Ebook({ id: '2', pdfPath: 'p', hotmartProductId: 'H', caktoProductId: 'C' });
  const parcial = new Ebook({ id: '3', pdfPath: 'p', hotmartProductId: 'H' });
  const r = svc.filterNeedsPublishing([semPdf, completo, parcial]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ebook.id, '3');
  assert.deepStrictEqual(r[0].platforms, ['cakto']);
  assert.deepStrictEqual(svc.filterNeedsPublishing([completo], ['amazon'])[0].platforms, ['amazon']);
  assert.deepStrictEqual(svc.filterNeedsPublishing([]), []);
});

test('isDuplicate: mesmo titulo com caixa e espaco diferentes e duplicata', () => {
  const existente = [new Ebook({ id: 'a', title: '  Investir em Acoes   com R$100 ' })];
  assert.strictEqual(svc.isDuplicate(new Ebook({ id: 'b', title: 'investir em acoes com r$100' }), existente), true);
});

test('isDuplicate: prefixo de 30 caracteres pega variacao de subtitulo', () => {
  const existente = [new Ebook({ id: 'a', title: 'Fundo de emergencia em 12 meses: guia pratico' })];
  assert.strictEqual(svc.isDuplicate(new Ebook({ id: 'b', title: 'Fundo de emergencia em 12 meses: edicao 2' }), existente), true);
});

test('isDuplicate NAO acusa: o proprio registro, titulo curto com prefixo comum, titulo diferente', () => {
  const proprio = new Ebook({ id: 'a', title: 'Dieta Low Carb Completa' });
  assert.strictEqual(svc.isDuplicate(proprio, [proprio]), false, 'comparar consigo mesmo nao e duplicata');
  // titulo com ate 10 caracteres so casa por igualdade exata
  assert.strictEqual(svc.isDuplicate(new Ebook({ id: 'b', title: 'Yoga' }), [new Ebook({ id: 'c', title: 'Yoga para iniciantes' })]), false);
  assert.strictEqual(svc.isDuplicate(new Ebook({ id: 'b', title: 'Marketing Digital' }), [new Ebook({ id: 'c', title: 'Dieta Low Carb' })]), false);
  assert.strictEqual(svc.isDuplicate(new Ebook({ id: 'b' }), [new Ebook({ id: 'c' })]), true, 'dois sem titulo sao iguais (vazio == vazio)');
});

test('sortByPriority ordena por score decrescente sem mexer no original', () => {
  const itens = [{ score: 10 }, { score: 90 }, { score: 50 }];
  assert.deepStrictEqual(svc.sortByPriority(itens).map(i => i.score), [90, 50, 10]);
  assert.deepStrictEqual(itens.map(i => i.score), [10, 90, 50]);
});

test('validateForPublishing lista cada motivo; titulo de exatamente 5 caracteres passa', () => {
  assert.deepStrictEqual(svc.validateForPublishing(new Ebook({ title: 'Cinco', pdfPath: 'p' })), { valid: true, reasons: [] });
  assert.deepStrictEqual(svc.validateForPublishing(new Ebook({ title: 'Quat', pdfPath: 'p' })).reasons, ['Title too short']);
  const r = svc.validateForPublishing(new Ebook({ status: 'publishing' }));
  assert.strictEqual(r.valid, false);
  assert.deepStrictEqual(r.reasons, ['Title too short', 'No PDF path', 'Already being published']);
});
