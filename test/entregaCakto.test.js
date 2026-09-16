'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planejar, alvo, camposAlterados, PRODUTOR } = require('../scripts/entregaCakto');

const LINK = 'https://publisher.veloxisit.com.br/entrega/abc.def';
const COM_NOME = { producerName: 'Veloxis Editorial' };

test('produto com link vazio recebe o link (o defeito real)', () => {
  for (const p of [{ emailAccessLink: null }, { emailAccessLink: '' }, {}]) {
    assert.strictEqual(planejar({ ...COM_NOME, ...p }, LINK), 'gravar');
    assert.deepStrictEqual(alvo({ ...COM_NOME, ...p }, LINK), { emailAccessLink: LINK });
  }
});

test('produto sem nome de vendedor recebe o nome, mesmo com link certo', () => {
  assert.deepStrictEqual(alvo({ emailAccessLink: LINK, producerName: null }, LINK), { producerName: PRODUTOR });
  assert.strictEqual(planejar({ emailAccessLink: LINK }, LINK), 'gravar');
});

test('tudo certo nao gasta chamada; nome ja preenchido nao e trocado (controle)', () => {
  assert.strictEqual(planejar({ emailAccessLink: LINK, producerName: 'Outro Nome' }, LINK), 'ok');
  assert.deepStrictEqual(alvo({ emailAccessLink: LINK, producerName: 'Outro Nome' }, LINK), {});
});

test('link nosso antigo e atualizado; link de terceiro nunca e sobrescrito (controle)', () => {
  assert.strictEqual(planejar({ ...COM_NOME, emailAccessLink: 'https://publisher.veloxisit.com.br/entrega/velho.x' }, LINK), 'gravar');
  assert.strictEqual(planejar({ ...COM_NOME, emailAccessLink: 'https://drive.google.com/arquivo' }, LINK), 'link-alheio');
  assert.deepStrictEqual(alvo({ emailAccessLink: 'https://drive.google.com/arquivo' }, LINK), { producerName: PRODUTOR });
});

test('imagem so e enviada para produto sem imagem e com capa em disco', () => {
  const { precisaImagem } = require('../scripts/entregaCakto');
  assert.strictEqual(precisaImagem({ image: null }, true), true);
  assert.strictEqual(precisaImagem({ image: null }, false), false);
  assert.strictEqual(precisaImagem({ image: 'https://cdn/x.jpg' }, true), false);
});

test('sem PDF: pausa so produto ativo; nao mexe no que ja esta parado (controle)', () => {
  const { acaoSemPdf } = require('../scripts/entregaCakto');
  assert.strictEqual(acaoSemPdf({ status: 'active' }), 'pausar');
  for (const st of ['waiting_config', 'blocked', 'deleted']) assert.strictEqual(acaoSemPdf({ status: st }), 'nada');
});

test('PDF voltou: reativa so o que ESTE job pausou', () => {
  const pausado = { ...COM_NOME, emailAccessLink: LINK, status: 'waiting_config' };
  assert.deepStrictEqual(alvo(pausado, LINK, true), { status: 'active' });
  assert.deepStrictEqual(alvo(pausado, LINK, false), {}, 'pausado por outra pessoa fica parado');
  assert.deepStrictEqual(alvo({ ...pausado, status: 'blocked' }, LINK, true), {}, 'bloqueio da Cakto nao e desfeito');
});

test('camposAlterados aponta so o que mudou', () => {
  assert.deepStrictEqual(camposAlterados({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true }), ['b', 'c', 'd']);
  assert.deepStrictEqual(camposAlterados(null, {}), []);
});

test('camposAlterados com uma das leituras ausente: tudo que existe do outro lado mudou', () => {
  // A releitura da Cakto pode falhar e voltar nula; o diff nao pode lancar.
  assert.deepStrictEqual(camposAlterados({ status: 'active', image: null }, null), ['status', 'image']);
  assert.deepStrictEqual(camposAlterados(undefined, { status: 'active' }), ['status']);
  assert.deepStrictEqual(camposAlterados(null, undefined), []);
});

test('sem link esperado e sem link no produto: nada a gravar nem a denunciar', () => {
  assert.strictEqual(planejar({ ...COM_NOME }, ''), 'ok');
  assert.strictEqual(planejar({ ...COM_NOME, emailAccessLink: 'https://drive.google.com/x' }, ''), 'link-alheio');
});

test('afiliacao: liga vitrine e comissao so onde esta desligada; comissao do dono fica', () => {
  const { COMISSAO_AFILIADO } = require('../scripts/entregaCakto');
  const base = { ...COM_NOME, emailAccessLink: LINK, affiliate: false, affiliateCommission: null, affiliateDescription: null };
  const r = alvo(base, LINK, false, { afiliacao: true });
  assert.deepStrictEqual([r.affiliate, r.affiliateRequest, r.affiliateMarketplace, r.affiliateCommission], [true, false, true, COMISSAO_AFILIADO]);
  assert.match(r.affiliateDescription, /50%/);
  assert.deepStrictEqual(alvo({ ...base, affiliateCommission: '30.00' }, LINK, false, { afiliacao: true }).affiliateCommission, undefined, 'comissao definida nao e trocada');
  assert.deepStrictEqual(alvo({ ...base, affiliate: true }, LINK, false, { afiliacao: true }), {}, 'ja afiliado: nada');
  assert.deepStrictEqual(alvo(base, LINK), {}, 'sem a opcao, comportamento antigo (controle)');
});

test('pagina de vendas apontando para hotmart.com vira o proprio checkout; pagina propria fica', () => {
  const ck = 'https://pay.cakto.com.br/abc';
  const base = { ...COM_NOME, emailAccessLink: LINK };
  assert.strictEqual(alvo({ ...base, salesPage: 'https://hotmart.com' }, LINK, false, { checkout: ck }).salesPage, ck);
  assert.strictEqual(alvo({ ...base, salesPage: 'https://www.hotmart.com/' }, LINK, false, { checkout: ck }).salesPage, ck);
  assert.strictEqual(alvo({ ...base, salesPage: null }, LINK, false, { checkout: ck }).salesPage, ck);
  assert.strictEqual(alvo({ ...base, salesPage: 'https://meusite.com/livro' }, LINK, false, { checkout: ck }).salesPage, undefined);
  assert.strictEqual(alvo({ ...base, salesPage: 'https://hotmart.com/pt-br/marketplace/produtos/x' }, LINK, false, { checkout: ck }).salesPage, undefined);
});

test('mesmoValor aceita numero devolvido como texto', () => {
  const { mesmoValor } = require('../scripts/entregaCakto');
  assert.ok(mesmoValor('50.00', 50));
  assert.ok(mesmoValor(true, true));
  assert.ok(!mesmoValor('40.00', 50));
  assert.ok(!mesmoValor('true', true));
});

test('comissao fora da faixa da Cakto (1% a 95%) e trocada; valida fica (caso real: 0.00 dava HTTP 400)', () => {
  const base = { ...COM_NOME, emailAccessLink: LINK, affiliate: false, affiliateDescription: 'x' };
  assert.strictEqual(alvo({ ...base, affiliateCommission: '0.00' }, LINK, false, { afiliacao: true }).affiliateCommission, 50);
  assert.strictEqual(alvo({ ...base, affiliateCommission: '99.00' }, LINK, false, { afiliacao: true }).affiliateCommission, 50);
  assert.strictEqual(alvo({ ...base, affiliateCommission: 'abc' }, LINK, false, { afiliacao: true }).affiliateCommission, 50);
  assert.strictEqual(alvo({ ...base, affiliateCommission: '1.00' }, LINK, false, { afiliacao: true }).affiliateCommission, undefined);
  assert.strictEqual(alvo({ ...base, affiliateCommission: '95.00' }, LINK, false, { afiliacao: true }).affiliateCommission, undefined);
});
