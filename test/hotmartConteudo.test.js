'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { temArquivo, consultarConteudo, aguardarConteudo } = require('../src/agents/hotmartConteudo');

test('resposta real de produto vendido sem arquivo e reprovada; com PDF passa', () => {
  assert.strictEqual(temArquivo({ contents: null, totalSize: 0, totalLength: 0 }), false);
  assert.strictEqual(temArquivo({ contents: [{ id: 8373322, name: 'e.pdf', size: 3351890 }] }), true);
  assert.strictEqual(temArquivo({ contents: [], totalSize: 10 }), true);
  assert.strictEqual(temArquivo({ contents: [{ size: 0 }] }), false, 'arquivo de 0 bytes nao entrega nada');
  for (const r of [null, undefined, 'x']) assert.strictEqual(temArquivo(r), false);
});

const resp = (status, corpo) => async () => ({ ok: status < 400, status, json: async () => corpo });

test('consulta: true/false pela API; null quando nao da para saber (controle)', async () => {
  assert.strictEqual(await consultarConteudo(1, { token: 't', fetchImpl: resp(200, { contents: [{ size: 5 }] }) }), true);
  assert.strictEqual(await consultarConteudo(1, { token: 't', fetchImpl: resp(200, { contents: null }) }), false);
  assert.strictEqual(await consultarConteudo(1, { token: 't', fetchImpl: resp(401, {}) }), null);
  assert.strictEqual(await consultarConteudo(1, { token: 't', fetchImpl: async () => { throw new Error('rede'); } }), null);
  let url, auth;
  await consultarConteudo(99, { token: 'abc', fetchImpl: async (u, o) => { url = u; auth = o.headers.authorization; return { ok: true, json: async () => ({}) }; } });
  assert.strictEqual(url, 'https://api-product.vulcano.hotmart.com/product/v1/product/99/content');
  assert.strictEqual(auth, 'Bearer abc');
});

test('consulta sem token (arquivo ausente) devolve null em vez de acusar falta de arquivo', async () => {
  const antigo = process.env.HOTMART_TOKEN_FILE;
  delete require.cache[require.resolve('../src/agents/hotmartConteudo')];
  process.env.HOTMART_TOKEN_FILE = require('path').join(require('os').tmpdir(), 'nao-existe-' + Date.now());
  const mod = require('../src/agents/hotmartConteudo');
  assert.strictEqual(await mod.consultarConteudo(1), null);
  if (antigo === undefined) delete process.env.HOTMART_TOKEN_FILE; else process.env.HOTMART_TOKEN_FILE = antigo;
  delete require.cache[require.resolve('../src/agents/hotmartConteudo')];
});

test('arquivo de token vazio nao vira "Bearer " na requisicao: devolve null', async t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmtoken-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arq = path.join(dir, 'token.txt');
  fs.writeFileSync(arq, '  \n');
  const { comAmbiente, recarregar } = require('./apoio');
  comAmbiente(t, { HOTMART_TOKEN_FILE: arq });
  const mod = recarregar('src/agents/hotmartConteudo.js');
  let chamou = false;
  assert.strictEqual(await mod.consultarConteudo(1, { fetchImpl: async () => { chamou = true; return { ok: true, json: async () => ({}) }; } }), null);
  assert.strictEqual(chamou, false);
  fs.writeFileSync(arq, 'tok-do-arquivo\n');
  let auth;
  await mod.consultarConteudo(1, { fetchImpl: async (u, o) => { auth = o.headers.authorization; return { ok: true, json: async () => ({ totalSize: 1 }) }; } });
  assert.strictEqual(auth, 'Bearer tok-do-arquivo');
});

test('aguardar sem dormir injetado espera o intervalo padrao de 10 s entre consultas', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const p = aguardarConteudo(1, { token: 't', tentativas: 2, fetchImpl: async () => { n++; return { ok: true, json: async () => ({ contents: null }) }; } });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(n, 1);
  t.mock.timers.tick(9999);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(n, 1, 'ainda dentro dos 10 s');
  t.mock.timers.tick(1);
  assert.strictEqual(await p, false);
  assert.strictEqual(n, 2);
});

test('aguardar: para assim que o arquivo aparece; esgota e devolve o ultimo estado', async () => {
  const seq = [{ contents: null }, { contents: null }, { contents: [{ size: 1 }] }];
  let n = 0, esperas = 0;
  const ok = await aguardarConteudo(1, { token: 't', tentativas: 5, dormir: async () => { esperas++; }, fetchImpl: async () => ({ ok: true, json: async () => seq[n++] }) });
  assert.deepStrictEqual([ok, n, esperas], [true, 3, 2]);

  let m = 0;
  const nunca = await aguardarConteudo(1, { token: 't', tentativas: 3, dormir: async () => {}, fetchImpl: async () => { m++; return { ok: true, json: async () => ({ contents: null }) }; } });
  assert.deepStrictEqual([nunca, m], [false, 3]);

  const semApi = await aguardarConteudo(1, { token: 't', tentativas: 2, dormir: async () => {}, fetchImpl: resp(500, {}) });
  assert.strictEqual(semApi, null);
});
