'use strict';
/**
 * publisherKiwify: o fluxo real (sem navegador). A "pagina" e um dublê que
 * EXECUTA as funcoes que iriam para dentro do Chrome, com `fetch` e
 * `localStorage` falsos — assim o codigo que roda no navegador tambem e
 * exercitado, e nao so a linha que chama `page.evaluate`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { interceptar, recarregar } = require('./apoio');
const { publicarNaKiwify, credenciais, catalogo, chamar } = require('../src/agents/publisherKiwify');

/** Resposta da API por (metodo, caminho). */
function paginaFalsa({ produtos = [], criar, ao_buscar_id, put = { status: 200, corpo: {} }, device = 'DEV123', bearer = 'Bearer xyz', falhaDeRede = false } = {}) {
  const chamadas = [];
  const ouvintes = [];
  const responder = (metodo, caminho, corpo) => {
    chamadas.push({ metodo, caminho, corpo: corpo ? JSON.parse(corpo) : null });
    if (falhaDeRede) throw new TypeError('Failed to fetch');
    if (metodo === 'GET' && caminho.endsWith('/v1/products')) return { status: 200, texto: JSON.stringify(produtos) };
    if (metodo === 'POST') return criar || { status: 500, texto: '{}' };
    if (metodo === 'GET') return ao_buscar_id || { status: 200, texto: JSON.stringify({ id: 'p1', name: 'Livro Novo' }) };
    if (metodo === 'PUT') return { status: put.status, texto: JSON.stringify(put.corpo) };
    return { status: 404, texto: '{}' };
  };
  return {
    chamadas,
    on: (ev, fn) => ouvintes.push([ev, fn]),
    off: (ev, fn) => {
      const i = ouvintes.findIndex(o => o[1] === fn);
      if (i >= 0) ouvintes.splice(i, 1);
    },
    goto: async () => {
      for (const [ev, fn] of ouvintes) {
        if (ev === 'request') {
          fn({ url: () => 'https://cdn.kiwify.com/app.js', headers: () => ({}) });
          fn({ url: () => 'https://admin-api.kiwify.com.br/v1/products', headers: () => (bearer ? { authorization: bearer } : {}) });
        }
      }
    },
    // executa de verdade a funcao que iria para o navegador
    evaluate: async (fn, ...args) => {
      const armazem = {};
      if (device) armazem['kiwi_device_token_uid'] = device;
      // localStorage do navegador: as chaves aparecem em Object.keys
      global.localStorage = Object.defineProperty({ ...armazem }, 'getItem', {
        value: k => (k in armazem ? armazem[k] : null), enumerable: false,
      });
      global.fetch = async (url, opcoes = {}) => {
        const caminho = String(url).replace('https://admin-api.kiwify.com.br', '');
        const r = responder(opcoes.method || 'GET', caminho, opcoes.body);
        return { status: r.status, text: async () => r.texto };
      };
      try { return await fn(...args); } finally { delete global.localStorage; }
    },
  };
}

const LIVRO = { title: 'Livro Novo', description: 'Descricao do livro.', language: 'pt-BR', preco: 5, paginaDeVendas: 'https://veloxisit.com.br/livros/x/', topic: 'financas' };
const CRED = { bearer: 'Bearer xyz', device: 'DEV123' };

test('livro novo: cria, confere o nome e grava a categoria', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p1' }) } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.strictEqual(r.jaExistia, false);
  assert.strictEqual(r.id, 'p1');
  assert.strictEqual(r.url, 'https://dashboard.kiwify.com/products/edit/p1');
  assert.strictEqual(r.categoria, 1, 'financas');
  const post = p.chamadas.find(c => c.metodo === 'POST');
  assert.strictEqual(post.corpo.price, 500);
  assert.strictEqual(post.corpo.currency, 'BRL');
  assert.strictEqual(post.corpo.type, 'club');
  const putc = p.chamadas.find(c => c.metodo === 'PUT');
  assert.strictEqual(putc.corpo.category, 1);
  assert.strictEqual(putc.corpo.soft_descriptor, 'LivroNovo');
  assert.strictEqual(putc.corpo.moneyback_guarantee, 7);
});

test('livro que ja esta la nao vira duplicata', async () => {
  const p = paginaFalsa({ produtos: [{ id: 'ja1', name: ' LIVRO   novo ' }] });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.deepStrictEqual([r.jaExistia, r.id], [true, 'ja1']);
  assert.ok(!p.chamadas.some(c => c.metodo === 'POST'), 'nao tenta criar de novo');
});

test('API recusando a criacao lanca com o status', async () => {
  const p = paginaFalsa({ criar: { status: 422, texto: '{"error":"price too low"}' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED }), /KIWIFY_CRIACAO_FALHOU: status 422/);
});

test('criou mas nao devolveu id: para, em vez de seguir no escuro', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: '{"ok":true}' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED }), /KIWIFY_SEM_ID/);
});

test('id devolvido dentro de product tambem serve', async () => {
  const p = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ product: { id: 'p7' } }) }, ao_buscar_id: { status: 200, texto: JSON.stringify({ product: { id: 'p7', name: 'Livro Novo' } }) } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.strictEqual(r.id, 'p7');
});

test('id que abre OUTRO produto nao recebe alteracao nenhuma', async () => {
  const p = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'p9' }) },
    ao_buscar_id: { status: 200, texto: JSON.stringify({ id: 'p9', name: 'Orçamento de Viagem de Luxo' }) },
  });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED }), /KIWIFY_PRODUTO_ERRADO/);
  assert.ok(!p.chamadas.some(c => c.metodo === 'PUT'), 'nada foi escrito no produto errado');
});

test('livro sem titulo nao vai para a loja', async () => {
  const p = paginaFalsa({});
  await assert.rejects(() => publicarNaKiwify(p, { ...LIVRO, title: '  ' }, { cred: CRED }), /KIWIFY_SEM_TITULO/);
});

test('categoria que falha nao perde o produto ja criado', async () => {
  const p = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ id: 'p2' }) }, put: { status: 500, corpo: {} } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.strictEqual(r.id, 'p2');
});

test('sem sessao aberta o agente diz o que falta, sem vazar credencial', async () => {
  const p = paginaFalsa({ bearer: null });
  await assert.rejects(() => credenciais(p, { espera: 0 }), e => {
    assert.match(e.message, /KIWIFY_SEM_SESSAO: .*bearer=false device=true/);
    assert.ok(!e.message.includes('DEV123'), 'o device token nao entra na mensagem');
    return true;
  });
});

test('sem device token no navegador tambem para', async () => {
  const p = paginaFalsa({ device: null });
  await assert.rejects(() => credenciais(p, { espera: 0 }), /device=false/);
});

test('sessao boa devolve os dois segredos e para de escutar', async () => {
  const p = paginaFalsa({});
  const c = await credenciais(p, { espera: 0 });
  assert.deepStrictEqual(c, { bearer: 'Bearer xyz', device: 'DEV123' });
});

test('catalogo aceita lista crua ou embrulhada, e API fora do ar nao quebra', async () => {
  const cru = await catalogo(paginaFalsa({ produtos: [{ id: 'a', name: 'A' }, null, { id: 'b' }] }), CRED);
  assert.strictEqual(cru.total, 3);
  assert.deepStrictEqual([...cru.porNome.keys()], ['a']);

  const p = paginaFalsa({});
  p.evaluate = async () => ({ status: 200, texto: JSON.stringify({ data: [{ id: 'c', name: 'C' }] }) });
  assert.strictEqual((await catalogo(p, CRED)).porNome.get('c'), 'c');

  const p2 = paginaFalsa({});
  p2.evaluate = async () => ({ status: 200, texto: JSON.stringify({ products: [{ id: 'd', name: 'D' }] }) });
  assert.strictEqual((await catalogo(p2, CRED)).porNome.get('d'), 'd');

  const p3 = paginaFalsa({});
  p3.evaluate = async () => ({ status: 500, texto: 'boom' });
  assert.strictEqual((await catalogo(p3, CRED)).total, 0, 'resposta que nao e JSON = catalogo vazio');
});

test('queda de rede vira status 0 com a causa, sem derrubar o processo', async () => {
  const p = paginaFalsa({ falhaDeRede: true });
  const r = await chamar(p, CRED, 'GET', '/v1/products');
  assert.strictEqual(r.status, 0);
  assert.match(r.texto, /Failed to fetch/);
});

test('sem o logger do projeto o agente ainda registra (console) e publica igual', async t => {
  const restaurar = interceptar(null, { '../core/logger': new Error('sem winston aqui') });
  const mod = recarregar('src/agents/publisherKiwify.js');
  restaurar();
  t.after(() => recarregar('src/agents/publisherKiwify.js'));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'pc' }) } });
  const r = await mod.publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.strictEqual(r.id, 'pc');

  const jaLa = paginaFalsa({ produtos: [{ id: 'j1', name: 'Livro Novo' }] });
  assert.strictEqual((await mod.publicarNaKiwify(jaLa, LIVRO, { cred: CRED })).jaExistia, true);

  const errado = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'pe' }) },
    ao_buscar_id: { status: 200, texto: JSON.stringify({ id: 'pe', name: 'Outro Livro' }) },
  });
  await assert.rejects(() => mod.publicarNaKiwify(errado, LIVRO, { cred: CRED }), /KIWIFY_PRODUTO_ERRADO/);

  const semCategoria = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ id: 'pw' }) }, put: { status: 500, corpo: {} } });
  assert.strictEqual((await mod.publicarNaKiwify(semCategoria, LIVRO, { cred: CRED })).id, 'pw');

  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({}), { title: '' }, { cred: CRED }), /KIWIFY_SEM_TITULO/);
  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({ criar: { status: 500, texto: 'x' } }), LIVRO, { cred: CRED }), /KIWIFY_CRIACAO_FALHOU/);
  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({ criar: { status: 200, texto: '{}' } }), LIVRO, { cred: CRED }), /KIWIFY_SEM_ID/);
  await assert.rejects(() => mod.credenciais(paginaFalsa({ bearer: null }), { espera: 0 }), /KIWIFY_SEM_SESSAO/);
  assert.deepStrictEqual(await mod.credenciais(paginaFalsa({}), { espera: 0 }), CRED);
  assert.strictEqual((await mod.chamar(paginaFalsa({ falhaDeRede: true }), CRED, 'GET', '/v1/products')).status, 0);
  const comCred = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ product: { id: 'pz' } }) }, ao_buscar_id: { status: 200, texto: JSON.stringify({ product: { id: 'pz', name: 'Livro Novo' } }) } });
  assert.strictEqual((await mod.publicarNaKiwify(comCred, LIVRO, { espera: 0 })).id, 'pz');
});

test('sem credencial na mao, o agente abre o painel e pega a sessao sozinho', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p5' }) } });
  const original = p.goto;
  p.goto = async (...a) => { p.abriu = true; return original(...a); };
  const r = await publicarNaKiwify(p, LIVRO, { espera: 0 });
  assert.strictEqual(p.abriu, true);
  assert.strictEqual(r.id, 'p5');
});

test('requisicao sem cabecalho nenhum nao derruba a captura da sessao', async () => {
  const p = paginaFalsa({});
  p.goto = async () => {
    for (const [ev, fn] of []) fn();
  };
  const ouvintes = [];
  p.on = (ev, fn) => ouvintes.push([ev, fn]);
  p.goto = async () => {
    ouvintes.forEach(([, fn]) => fn({ url: () => 'https://admin-api.kiwify.com.br/v1/x', headers: () => undefined }));
    ouvintes.forEach(([, fn]) => fn({ url: () => 'https://admin-api.kiwify.com.br/v1/y', headers: () => ({ authorization: 'Bearer novo' }) }));
  };
  const c = await credenciais(p, { espera: 0 });
  assert.strictEqual(c.bearer, 'Bearer novo');
});

test('produto criado cujo GET volta ilegivel: segue com o que sabe', async () => {
  const p = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'p8' }) },
    ao_buscar_id: { status: 502, texto: '<html>gateway</html>' },
  });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED });
  assert.strictEqual(r.id, 'p8');
  const putc = p.chamadas.find(c => c.metodo === 'PUT');
  assert.strictEqual(putc.corpo.name, 'Livro Novo', 'monta o PUT mesmo sem o objeto anterior');
});

test('livro sem a chave title e produto sem id no catalogo nao quebram o log', async () => {
  const p = paginaFalsa({});
  await assert.rejects(() => publicarNaKiwify(p, { language: 'pt-BR' }, { cred: CRED }), /KIWIFY_SEM_TITULO/);

  const p2 = paginaFalsa({ produtos: [{ name: 'Livro Novo' }] });
  const r = await publicarNaKiwify(p2, LIVRO, { cred: CRED });
  assert.strictEqual(r.jaExistia, true);
  assert.strictEqual(r.url, 'https://dashboard.kiwify.com/products/edit/undefined');
});

test('painel que nao abre e localStorage bloqueado nao derrubam o processo', async () => {
  const p = paginaFalsa({});
  p.goto = async () => { throw new Error('net::ERR_TIMED_OUT'); };
  await assert.rejects(() => credenciais(p, { espera: 0 }), /KIWIFY_SEM_SESSAO: .*bearer=false/);

  const p2 = paginaFalsa({});
  p2.evaluate = async () => { throw new Error('localStorage bloqueado'); };
  await assert.rejects(() => credenciais(p2, { espera: 0 }), /device=false/);
});
