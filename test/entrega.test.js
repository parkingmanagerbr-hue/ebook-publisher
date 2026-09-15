'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gerarToken, verificarToken, urlEntrega, nomeArquivo, criarRota, SEGREDO_PADRAO_INSEGURO } = require('../src/core/entrega');

const ENV = { ENTREGA_SECRET: 'segredo-de-teste' };
const ID = '0c104665-ee04-4964-aab3-e781471f1247';

test('token autentico volta o id; trocar o id invalida (controle)', () => {
  const t = gerarToken(ID, ENV);
  assert.strictEqual(verificarToken(t, ENV), ID);
  const outro = 'ffffffff-ee04-4964-aab3-e781471f1247';
  assert.strictEqual(verificarToken(outro + t.slice(ID.length), ENV), null);
  assert.strictEqual(verificarToken(t, { ENTREGA_SECRET: 'outro' }), null);
  assert.strictEqual(verificarToken('lixo', ENV), null);
  assert.strictEqual(verificarToken(undefined, ENV), null);
});

test('segredo ausente ou padrao do codigo recusa gerar link', () => {
  assert.throws(() => gerarToken(ID, {}));
  assert.throws(() => gerarToken(ID, { JWT_SECRET: SEGREDO_PADRAO_INSEGURO }));
  assert.ok(gerarToken(ID, { JWT_SECRET: 'x' }));
  assert.throws(() => gerarToken('../etc/passwd', ENV));
});

test('url usa a base publica e o nome de arquivo sai seguro', () => {
  assert.ok(urlEntrega(ID, ENV).startsWith('https://publisher.veloxisit.com.br/entrega/' + ID + '.'));
  assert.ok(urlEntrega(ID, { ...ENV, PUBLIC_BASE_URL: 'https://x.test/' }).startsWith('https://x.test/entrega/'));
  assert.strictEqual(nomeArquivo('A/B: "C"?'), 'A B C.pdf');
  assert.strictEqual(nomeArquivo('a' + String.fromCharCode(92) + 'b' + String.fromCharCode(0, 10) + 'c'), 'a b c.pdf');
  assert.strictEqual(nomeArquivo(''), 'ebook.pdf');
});

function resFalso() {
  const r = { headers: {}, status(c) { r.code = c; return r; }, send(b) { r.body = b; return r; },
    set(k, v) { r.headers[k] = v; return r; }, sendFile(p) { r.code = 200; r.arquivo = p; return r; } };
  return r;
}
const fsFalso = existe => ({ existsSync: () => existe });

test('rota: entrega o PDF com token certo, 404 com token errado, 410 sem arquivo, 503 sem segredo', () => {
  const buscar = id => (id === ID ? { title: 'Liderança', pdf_path: '/data/pdfs/a.pdf' } : null);
  let res = resFalso();
  criarRota(buscar, fsFalso(true), ENV)({ params: { token: gerarToken(ID, ENV) } }, res);
  assert.strictEqual(res.code, 200);
  assert.match(res.headers['Content-Disposition'], /Lideran%C3%A7a\.pdf/);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');

  res = resFalso();
  criarRota(buscar, fsFalso(true), ENV)({ params: { token: 'x.y' } }, res);
  assert.strictEqual(res.code, 404);

  res = resFalso();
  criarRota(buscar, fsFalso(false), ENV)({ params: { token: gerarToken(ID, ENV) } }, res);
  assert.strictEqual(res.code, 410);

  res = resFalso();
  criarRota(() => null, fsFalso(true), ENV)({ params: { token: gerarToken(ID, ENV) } }, res);
  assert.strictEqual(res.code, 410);

  res = resFalso();
  criarRota(buscar, fsFalso(true), {})({ params: { token: 'a.b' } }, res);
  assert.strictEqual(res.code, 503);
});
