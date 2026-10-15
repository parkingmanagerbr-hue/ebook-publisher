'use strict';
/**
 * Kiwify: o link de compra publico (o banco so tinha o PAINEL) e a entrega
 * conferida (produtos ativos com approved_url vazio, 13/10/2026).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { approvedUrlDe, motivoSemEntrega, checkoutPublico, desfechoDaFalha, CHECKOUT_KIWIFY, produtoCompleto } = require('../src/agents/kiwifyRegras');
const imp = require('../scripts/kiwifyCheckoutDoArquivo');

const LINK = 'https://publisher.veloxisit.com.br/entrega/livro-0001.' + 'S'.repeat(32);

test('approved_url vem de checkout ou solto; ausente e vazio', () => {
  assert.strictEqual(approvedUrlDe({ checkout: { approved_url: ' ' + LINK + ' ' } }), LINK);
  assert.strictEqual(approvedUrlDe({ approved_url: LINK }), LINK);
  assert.strictEqual(approvedUrlDe({ checkout: {} }), '');
  assert.strictEqual(approvedUrlDe(null), '');
});

test('entrega: vazia, de outro livro ou com token que nao abre este livro reprova', () => {
  const p = { checkout: { approved_url: LINK } };
  assert.strictEqual(motivoSemEntrega(p), null, 'sem nada a comparar, basta existir');
  assert.strictEqual(motivoSemEntrega(p, { linkEsperado: LINK }), null);
  assert.strictEqual(motivoSemEntrega({}, { linkEsperado: LINK }), 'approved_url vazio');
  assert.strictEqual(motivoSemEntrega(p, { linkEsperado: LINK.replace('0001', '0002') }), 'approved_url diferente do link deste livro');
  const ok = t => (t === 'livro-0001.' + 'S'.repeat(32) ? 'livro-0001' : null);
  assert.strictEqual(motivoSemEntrega(p, { ebookId: 'livro-0001', verificar: ok }), null);
  assert.strictEqual(motivoSemEntrega(p, { ebookId: 'livro-0002', verificar: ok }), 'token do approved_url nao abre este livro');
  assert.strictEqual(motivoSemEntrega({ approved_url: 'https://outro.site/x' }, { ebookId: 'livro-0001', verificar: ok }), 'token do approved_url nao abre este livro',
    'url que nem e de entrega');
  assert.strictEqual(motivoSemEntrega(p, { ebookId: 'livro-0001', verificar: () => { throw new Error('x'); } }), 'token do approved_url nao abre este livro');
});

test('checkout publico: so plano ativo e nao privado, com id alfanumerico', () => {
  const plano = (x = {}) => ({ id: 'sVgIhNe', type: 'plan', status: 'active', private: false, ...x });
  assert.strictEqual(checkoutPublico({ links: [plano()] }), 'https://pay.kiwify.com.br/sVgIhNe');
  assert.strictEqual(checkoutPublico({ checkout: { links: [null, plano({ private: true }), plano({ id: 'Outro1' })] } }), 'https://pay.kiwify.com.br/Outro1', 'pula o privado');
  assert.strictEqual(checkoutPublico({ links: [plano({ status: 'disabled' })] }), null);
  assert.strictEqual(checkoutPublico({ links: [plano({ type: 'upsell' })] }), null);
  assert.strictEqual(checkoutPublico({ links: [plano({ private: undefined })] }), null, 'privado so e falso quando dito');
  assert.strictEqual(checkoutPublico({ links: [plano({ id: '../x' })] }), null);
  assert.strictEqual(checkoutPublico({ links: [plano({ id: undefined })] }), null);
  assert.strictEqual(checkoutPublico({ checkout: {} }), null);
  assert.strictEqual(checkoutPublico(null), null);
  assert.ok(!CHECKOUT_KIWIFY.test('https://dashboard.kiwify.com/products/edit/abc'));
});

test('desfecho da falha: recusa sai da fila, sem-entrega conta tentativa, o resto tenta de novo', () => {
  assert.deepStrictEqual(desfechoDaFalha('KIWIFY_RECUSADO: casino'), { tipo: 'recusado', detalhe: 'casino' });
  assert.deepStrictEqual(desfechoDaFalha('KIWIFY_SEM_ENTREGA: approved_url vazio id=p2'), { tipo: 'sem-entrega', detalhe: 'approved_url vazio id=p2' });
  assert.strictEqual(desfechoDaFalha('KIWIFY_CRIACAO_FALHOU: status 429').tipo, 'falha');
  assert.strictEqual(desfechoDaFalha(null).tipo, 'falha');
});

test('linha da auditoria: so produto que se compra E se recebe vira link', () => {
  const ok = { ebook: 'e1', kid: 'k1', http: 200, status: 'active', soft_ban: false, entrega: 'ok', checkout: 'https://pay.kiwify.com.br/sVgIhNe' };
  assert.deepStrictEqual(imp.decidirLinha(ok), { acao: 'gravar', checkout: 'https://pay.kiwify.com.br/sVgIhNe' });
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, entrega: 'vazia' }), { acao: 'limpar', motivo: 'sem-entrega' }, 'pagar e nao receber: fora da vitrine');
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, status: 'inactive' }), { acao: 'limpar', motivo: 'inativo' });
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, soft_ban: true }), { acao: 'limpar', motivo: 'soft-ban' });
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, soft_ban: undefined }), { acao: 'limpar', motivo: 'soft-ban' }, 'sem a informacao, nao presume');
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, checkout: 'https://dashboard.kiwify.com/x' }), { acao: 'limpar', motivo: 'checkout-fora-do-formato' });
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, checkout: null }), { acao: 'limpar', motivo: 'checkout-fora-do-formato' });
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, http: 429 }), { acao: 'ignorar', motivo: 'leitura-falhou' }, 'nao mediu: nao apaga o que existe');
  assert.deepStrictEqual(imp.decidirLinha({ ...ok, kid: '' }), { acao: 'ignorar', motivo: 'linha-incompleta' });
  assert.deepStrictEqual(imp.decidirLinha(null), { acao: 'ignorar', motivo: 'linha-incompleta' });
});

test('importacao: grava, limpa o que deixou de servir, so no produto ligado ao livro, e o dry-run nao escreve', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT, kiwify_product_id TEXT)');
  const ins = db.prepare('INSERT INTO ebooks (id, kiwify_product_id) VALUES (?, ?)');
  ins.run('e1', 'k1'); ins.run('e2', 'k2'); ins.run('e3', 'k3'); ins.run('e4', 'k4');
  imp.prepararBanco(db);
  db.prepare("UPDATE ebooks SET kiwify_checkout = 'https://pay.kiwify.com.br/Velho1' WHERE id = 'e2'").run();
  const base = { http: 200, status: 'active', soft_ban: false, entrega: 'ok' };
  const texto = [
    JSON.stringify({ ...base, ebook: 'e1', kid: 'k1', checkout: 'https://pay.kiwify.com.br/Prim1' }),
    'isto nao e json',
    JSON.stringify({ ...base, ebook: 'e1', kid: 'k1', checkout: 'https://pay.kiwify.com.br/Ult1' }),
    JSON.stringify({ ...base, ebook: 'e2', kid: 'k2', entrega: 'vazia', checkout: 'https://pay.kiwify.com.br/Novo2' }),
    JSON.stringify({ ...base, ebook: 'e3', kid: 'OUTRO', checkout: 'https://pay.kiwify.com.br/Errado3' }),
    JSON.stringify({ ...base, ebook: 'e4', kid: 'k4', http: 0 }),
    JSON.stringify({ ...base, ebook: 'nao-existe', kid: 'k9', checkout: 'https://pay.kiwify.com.br/X9' }),
    '',
  ].join('\n');
  const checkout = id => db.prepare('SELECT kiwify_checkout c FROM ebooks WHERE id = ?').get(id).c;

  const seco = imp.importar(db, texto, { seco: true });
  assert.strictEqual(seco.gravados, 1);
  assert.strictEqual(checkout('e1'), null, 'dry-run nao escreve');
  assert.strictEqual(checkout('e2'), 'https://pay.kiwify.com.br/Velho1');

  const r = imp.importar(db, texto);
  assert.deepStrictEqual(r, { linhas: 6, ilegiveis: 1, gravados: 1, limpos: 1, ignorados: 1, produtoNaoConfere: 2,
    motivos: { 'sem-entrega': 1, 'leitura-falhou': 1 } });
  assert.strictEqual(checkout('e1'), 'https://pay.kiwify.com.br/Ult1', 'a ultima medicao do livro vale');
  assert.strictEqual(checkout('e2'), null, 'produto sem entrega sai da vitrine');
  assert.strictEqual(checkout('e3'), null, 'kid de outro produto nao grava');
  assert.strictEqual(checkout('e4'), null);
  assert.deepStrictEqual(imp.lerArquivo(''), { linhas: [], ilegiveis: 0 });
});


test('produto completo junta product, checkout e links da resposta real', () => {
  const j = { product: { id: 'k', name: 'N' }, checkout: { approved_url: LINK }, links: [{ id: 'aBc1234', type: 'plan', status: 'active', private: false }] };
  const p = produtoCompleto(j);
  assert.strictEqual(p.name, 'N');
  assert.strictEqual(approvedUrlDe(p), LINK);
  assert.strictEqual(checkoutPublico(p), 'https://pay.kiwify.com.br/aBc1234');
  assert.strictEqual(approvedUrlDe(j.product), '', 'so product nao tem a entrega: era o defeito');
  const dentro = produtoCompleto({ product: { id: 'k', checkout: { approved_url: LINK }, links: [] } });
  assert.strictEqual(approvedUrlDe(dentro), LINK, 'checkout dentro de product tambem serve');
  assert.deepStrictEqual(produtoCompleto({ id: 'solto' }), { id: 'solto' }, 'resposta sem product fica como veio');
  assert.deepStrictEqual(produtoCompleto({ product: 'x' }), { product: 'x' });
  assert.strictEqual(produtoCompleto(null), null);
});
