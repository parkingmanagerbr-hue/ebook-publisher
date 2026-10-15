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
// O servidor falso guarda o approved_url que o PUT gravou (so quando o PUT
// passa), e o GET seguinte devolve esse estado — e o que a conferencia de
// entrega le. `entregaInicial`: approved_url que o produto ja tinha (caso
// "ja estava na Kiwify"). `conferencia`: resposta fixa para os GETs depois do
// primeiro. `links`: planos de checkout do produto.
const PLANO = [{ id: 'sVgIhNe', type: 'plan', status: 'active', private: false }];
function paginaFalsa({ produtos = [], criar, ao_buscar_id, put = { status: 200, corpo: {} }, device = 'DEV123', bearer = 'Bearer xyz', falhaDeRede = false,
  entregaInicial = '', conferencia, links = PLANO } = {}) {
  const chamadas = [];
  const ouvintes = [];
  let approved = entregaInicial;
  let getsPorId = 0;
  const responder = (metodo, caminho, corpo) => {
    chamadas.push({ metodo, caminho, corpo: corpo ? JSON.parse(corpo) : null });
    if (falhaDeRede) throw new TypeError('Failed to fetch');
    if (metodo === 'GET' && caminho.endsWith('/v1/products')) return { status: 200, texto: JSON.stringify(produtos) };
    if (metodo === 'POST') return criar || { status: 500, texto: '{}' };
    if (metodo === 'GET') {
      getsPorId++;
      if (getsPorId === 1 && ao_buscar_id) return ao_buscar_id;
      if (getsPorId > 1 && conferencia) return Array.isArray(conferencia) ? conferencia[Math.min(getsPorId - 2, conferencia.length - 1)] : conferencia;
      let base = { id: 'p1', name: 'Livro Novo' };
      try { const j = ao_buscar_id && JSON.parse(ao_buscar_id.texto); if (j) base = j.product || j; } catch (_) { /* GET ilegivel no primeiro */ }
      // Forma REAL da resposta (medida em 15/10/2026): product, checkout e links lado a lado.
      return { status: 200, texto: JSON.stringify({ product: base, checkout: { approved_url: approved }, links }) };
    }
    if (metodo === 'PUT') {
      if (put.status < 400) approved = JSON.parse(corpo).approved_url;
      return { status: put.status, texto: JSON.stringify(put.corpo) };
    }
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

const ENTREGA = 'https://publisher.veloxisit.com.br/entrega/ebook-0001.' + 'S'.repeat(32);
const LIVRO = { title: 'Livro Novo', description: 'Descricao do livro.', language: 'pt-BR', preco: 5, paginaDeVendas: 'https://veloxisit.com.br/livros/x/', topic: 'financas', ebookId: 'ebook-0001', linkDeEntrega: ENTREGA };
const CRED = { bearer: 'Bearer xyz', device: 'DEV123' };
const SEM_ESPERA = async () => {};

test('livro novo: cria, confere o nome e grava a categoria', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p1' }) } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
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
  const p = paginaFalsa({ produtos: [{ id: 'ja1', name: ' LIVRO   novo ' }], entregaInicial: ENTREGA });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.deepStrictEqual([r.jaExistia, r.id], [true, 'ja1']);
  assert.ok(!p.chamadas.some(c => c.metodo === 'POST'), 'nao tenta criar de novo');
});

test('API recusando a criacao lanca com o status', async () => {
  const p = paginaFalsa({ criar: { status: 422, texto: '{"error":"price too low"}' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_CRIACAO_FALHOU: status 422/);
});

test('criou mas nao devolveu id: para, em vez de seguir no escuro', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: '{"ok":true}' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ID/);
});

test('id devolvido dentro de product tambem serve', async () => {
  const p = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ product: { id: 'p7' } }) }, ao_buscar_id: { status: 200, texto: JSON.stringify({ product: { id: 'p7', name: 'Livro Novo' } }) } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.strictEqual(r.id, 'p7');
});

test('id que abre OUTRO produto nao recebe alteracao nenhuma', async () => {
  const p = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'p9' }) },
    ao_buscar_id: { status: 200, texto: JSON.stringify({ id: 'p9', name: 'Orçamento de Viagem de Luxo' }) },
  });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_PRODUTO_ERRADO/);
  assert.ok(!p.chamadas.some(c => c.metodo === 'PUT'), 'nada foi escrito no produto errado');
});

test('livro sem titulo nao vai para a loja', async () => {
  const p = paginaFalsa({});
  await assert.rejects(() => publicarNaKiwify(p, { ...LIVRO, title: '  ' }, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_TITULO/);
});

test('PUT que falha deixa o produto SEM ENTREGA: nao e dado por publicado, e o erro leva o id criado', async () => {
  // 13/10/2026: produtos ativos com approved_url vazio. O PUT pos-criacao leva a
  // entrega; quando ele falhava, o log dizia "categoria nao entrou" e o livro
  // era gravado como publicado.
  const p = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ id: 'p2' }) }, put: { status: 500, corpo: {} } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), e => {
    assert.match(e.message, /^KIWIFY_SEM_ENTREGA: approved_url vazio id=p2$/);
    assert.strictEqual(e.idKiwify, 'p2');
    return true;
  });
  const metodos = p.chamadas.map(c => c.metodo + ' ' + c.caminho);
  assert.strictEqual(metodos[metodos.length - 1], 'GET /v1/products/p2?full=true', 'conferiu lendo o produto DEPOIS do PUT');
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
  const r = await mod.publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.strictEqual(r.id, 'pc');

  const jaLa = paginaFalsa({ produtos: [{ id: 'j1', name: 'Livro Novo' }], entregaInicial: ENTREGA });
  assert.strictEqual((await mod.publicarNaKiwify(jaLa, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA })).jaExistia, true);

  const errado = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'pe' }) },
    ao_buscar_id: { status: 200, texto: JSON.stringify({ id: 'pe', name: 'Outro Livro' }) },
  });
  await assert.rejects(() => mod.publicarNaKiwify(errado, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_PRODUTO_ERRADO/);

  const semCategoria = paginaFalsa({ criar: { status: 201, texto: JSON.stringify({ id: 'pw' }) }, put: { status: 500, corpo: {} } });
  await assert.rejects(() => mod.publicarNaKiwify(semCategoria, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ENTREGA/);

  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({}), { title: '' }, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_TITULO/);
  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({ criar: { status: 500, texto: 'x' } }), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_CRIACAO_FALHOU/);
  await assert.rejects(() => mod.publicarNaKiwify(paginaFalsa({ criar: { status: 200, texto: '{}' } }), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ID/);
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
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.strictEqual(r.id, 'p8');
  const putc = p.chamadas.find(c => c.metodo === 'PUT');
  assert.strictEqual(putc.corpo.name, 'Livro Novo', 'monta o PUT mesmo sem o objeto anterior');
});

test('livro sem a chave title e produto sem id no catalogo nao quebram o log', async () => {
  const p = paginaFalsa({});
  await assert.rejects(() => publicarNaKiwify(p, { language: 'pt-BR' }, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_TITULO/);

  const p2 = paginaFalsa({ produtos: [{ name: 'Livro Novo' }], entregaInicial: ENTREGA });
  const r = await publicarNaKiwify(p2, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
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

test('livro recusado pelo filtro da Kiwify nao insiste (erro proprio)', async () => {
  const p = paginaFalsa({ criar: { status: 400, texto: '{"error":"ProductNotAllowed","keyword":"casino"}' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), e => {
    assert.match(e.message, /^KIWIFY_RECUSADO: casino$/);
    return true;
  });
  assert.ok(!p.chamadas.some(c => c.metodo === 'PUT'), 'nada mais e enviado');
});

test('429 nao perde o livro: espera e tenta de novo', async () => {
  let vez = 0;
  const p = paginaFalsa({});
  const esperas = [];
  p.evaluate = async (fn, ...args) => {
    const [, , , metodo, caminho] = args;
    if (metodo === 'GET' && caminho.endsWith('/v1/products')) return { status: 200, texto: '[]' };
    if (metodo === 'POST') { vez++; return vez < 3 ? { status: 429, texto: 'Rate limit exceeded' } : { status: 200, texto: JSON.stringify({ id: 'pr' }) }; }
    if (metodo === 'GET') return { status: 200, texto: JSON.stringify({ product: { id: 'pr', name: 'Livro Novo', checkout: { approved_url: ENTREGA } } }) };
    return { status: 200, texto: '{}' };
  };
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, opcoesDeChamada: { tentativas: 3, esperar: async ms => { esperas.push(ms); } } });
  assert.strictEqual(r.id, 'pr');
  assert.strictEqual(vez, 3, 'tentou ate passar');
  assert.deepStrictEqual(esperas, [5000, 15000], 'esperou mais a cada vez');
});

test('429 insistente desiste com a mensagem da API', async () => {
  const p = paginaFalsa({});
  p.evaluate = async (fn, ...args) => {
    const [, , , metodo, caminho] = args;
    if (metodo === 'GET' && caminho.endsWith('/v1/products')) return { status: 200, texto: '[]' };
    return { status: 429, texto: 'Rate limit exceeded' };
  };
  await assert.rejects(
    () => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, opcoesDeChamada: { tentativas: 2, esperar: async () => {} } }),
    /KIWIFY_CRIACAO_FALHOU: status 429/);
});

test('REGRESSAO: catalogo grande nao pode ser cortado (JSON quebrado = duplicata)', async () => {
  // 25/09/2026: a resposta era cortada em 4.000 caracteres, o JSON da listagem
  // virava invalido, o catalogo voltava VAZIO e o robo republicava o que ja
  // estava na loja.
  const muitos = Array.from({ length: 200 }, (_, i) => ({
    id: 'p' + i, name: 'Livro numero ' + i + ' com um titulo longo o suficiente para encher a resposta',
  }));
  const p = paginaFalsa({ produtos: muitos });
  const { total, porNome } = await catalogo(p, CRED);
  assert.strictEqual(total, 200, 'a lista inteira precisa chegar');
  assert.strictEqual(porNome.size, 200);
  assert.ok(porNome.has('livro numero 199 com um titulo longo o suficiente para encher a resposta'));
});

// 09/10/2026: titulo acima de 100 caracteres virava um produto novo por rodada
// (58 livros -> 200 produtos). A Kiwify guarda o nome cortado.
const LONGO = 'Barba e Pele Impecaveis: O Guia Definitivo para Homens: Domine a Rotina de Cuidados e Eleve sua Autoestima Todo Dia';

test('titulo longo que ja esta la (nome cortado em 100) e achado, nao duplicado', async () => {
  assert.ok(LONGO.length > 100);
  const p = paginaFalsa({ produtos: [{ id: 'longo1', name: LONGO.slice(0, 100) }], entregaInicial: ENTREGA });
  const r = await publicarNaKiwify(p, { ...LIVRO, title: LONGO }, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.deepStrictEqual([r.jaExistia, r.id], [true, 'longo1']);
  assert.ok(!p.chamadas.some(c => c.metodo === 'POST'), 'nao cria a segunda copia');
});

test('titulo longo recem-criado passa na conferencia e grava (antes: PRODUTO_ERRADO e id perdido)', async () => {
  const p = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'longo2' }) },
    ao_buscar_id: { status: 200, texto: JSON.stringify({ id: 'longo2', name: LONGO.slice(0, 100) }) },
  });
  const r = await publicarNaKiwify(p, { ...LIVRO, title: LONGO }, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.deepStrictEqual([r.jaExistia, r.id], [false, 'longo2']);
  assert.strictEqual(p.chamadas.find(c => c.metodo === 'POST').corpo.name, LONGO.slice(0, 100));
  assert.ok(p.chamadas.some(c => c.metodo === 'PUT'), 'seguiu ate gravar a categoria');
});


// ── entrega conferida (13/10/2026) ──────────────────────────────────────────

test('livro novo: le o produto de volta, confere a entrega e devolve o checkout publico', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p1' }) } });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.strictEqual(r.checkout, 'https://pay.kiwify.com.br/sVgIhNe');
  const putc = p.chamadas.find(c => c.metodo === 'PUT');
  assert.strictEqual(putc.corpo.approved_url, ENTREGA, 'o PUT leva o link assinado deste livro');
  const gets = p.chamadas.filter(c => c.metodo === 'GET' && c.caminho === '/v1/products/p1?full=true');
  assert.strictEqual(gets.length, 2, 'um GET para montar o PUT, outro para conferir');
});

test('PUT que diz 200 mas nao grava a entrega tambem nao passa', async () => {
  const p = paginaFalsa({
    criar: { status: 200, texto: JSON.stringify({ id: 'p3' }) },
    conferencia: { status: 200, texto: JSON.stringify({ id: 'p3', name: 'Livro Novo', checkout: { approved_url: '' } }) },
  });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ENTREGA: approved_url vazio/);
});

test('conferencia ilegivel bloqueia, mas como "nao consegui medir" — nunca como sem entrega', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p4' }) }, conferencia: { status: 502, texto: '<html>' } });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), e => {
    assert.match(e.message, /^KIWIFY_SEM_CONFERENCIA: nenhuma leitura legivel id=p4$/);
    assert.strictEqual(e.idKiwify, 'p4');
    return true;
  });
  const p2 = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p4' }) }, conferencia: { status: 500, texto: '{"error":"interno"}' } });
  await assert.rejects(() => publicarNaKiwify(p2, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_CONFERENCIA/, '500 com JSON tambem e leitura que falhou');
});

test('"ja estava na Kiwify" sem entrega: nao liga o livro e nao mexe no produto', async () => {
  const p = paginaFalsa({ produtos: [{ id: 'velho', name: 'Livro Novo' }], entregaInicial: '' });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), e => e.idKiwify === 'velho' && /approved_url vazio/.test(e.message));
  assert.ok(!p.chamadas.some(c => c.metodo === 'POST' || c.metodo === 'PUT'), 'so leitura');
  const outro = paginaFalsa({ produtos: [{ id: 'velho', name: 'Livro Novo' }], entregaInicial: ENTREGA.replace('ebook-0001', 'ebook-9999') });
  await assert.rejects(() => publicarNaKiwify(outro, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /diferente do link deste livro/, 'entrega de OUTRO livro');
});

test('no servidor o token do approved_url tem de abrir ESTE livro', async () => {
  const jaLa = () => paginaFalsa({ produtos: [{ id: 'j9', name: 'Livro Novo' }], entregaInicial: ENTREGA });
  const tokens = [];
  const r = await publicarNaKiwify(jaLa(), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, verificarEntrega: t => { tokens.push(t); return 'ebook-0001'; } });
  assert.strictEqual(r.jaExistia, true);
  assert.deepStrictEqual(tokens, ['ebook-0001.' + 'S'.repeat(32)], 'verificou o token do link');
  await assert.rejects(() => publicarNaKiwify(jaLa(), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, verificarEntrega: () => null }), /token do approved_url nao abre este livro/);
  await assert.rejects(() => publicarNaKiwify(jaLa(), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, verificarEntrega: () => 'ebook-0002' }), /nao abre este livro/);
  await assert.rejects(() => publicarNaKiwify(jaLa(), LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA, verificarEntrega: () => { throw new Error('sem segredo'); } }), /nao abre este livro/);
});

test('livro sem link de entrega nem chega a criar o produto', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p5' }) } });
  await assert.rejects(() => publicarNaKiwify(p, { ...LIVRO, linkDeEntrega: '' }, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ENTREGA: livro sem link de entrega/);
  assert.ok(!p.chamadas.some(c => c.metodo === 'POST'), 'nao nasce produto a venda sem entrega');
});

test('sem plano publico ativo, publica com o checkout vazio (a vitrine nao ganha link)', async () => {
  for (const links of [[{ id: 'Ab12', type: 'plan', status: 'active', private: true }], [{ id: 'Ab12', type: 'plan', status: 'inactive', private: false }], []]) {
    const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'p6' }) }, links });
    assert.strictEqual((await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA })).checkout, null);
  }
});


// ── a Kiwify demora a refletir o PUT (14/10/2026: 10 de 10 falsos SEM_ENTREGA) ──

const vazio = id => ({ status: 200, texto: JSON.stringify({ id, name: 'Livro Novo', checkout: { approved_url: '' } }) });
const certo = id => ({ status: 200, texto: JSON.stringify({ id, name: 'Livro Novo', checkout: { approved_url: ENTREGA }, links: PLANO }) });

test('1a leitura vazia e a 2a certa: publicado, depois de esperar 1,5 s e 3 s', async () => {
  const esperas = [];
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'k1' }) }, conferencia: [vazio('k1'), certo('k1')] });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: async ms => { esperas.push(ms); } });
  assert.strictEqual(r.id, 'k1');
  assert.strictEqual(r.checkout, 'https://pay.kiwify.com.br/sVgIhNe');
  assert.deepStrictEqual(esperas, [1500, 3000], 'esperou antes de cada leitura e parou na que conferiu');
});

test('as 3 leituras vazias: SEM_ENTREGA, depois de 1,5 s, 3 s e 6 s', async () => {
  const esperas = [];
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'k2' }) }, conferencia: [vazio('k2'), vazio('k2'), vazio('k2')] });
  await assert.rejects(() => publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: async ms => { esperas.push(ms); } }), /KIWIFY_SEM_ENTREGA: approved_url vazio id=k2/);
  assert.deepStrictEqual(esperas, [1500, 3000, 6000]);
  assert.strictEqual(p.chamadas.filter(c => c.metodo === 'GET' && c.caminho === '/v1/products/k2?full=true').length, 4, '1 para montar o PUT + 3 de conferencia');
});

test('leitura ilegivel no meio nao vira sem entrega, e a ultima certa libera', async () => {
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'k3' }) }, conferencia: [{ status: 0, texto: 'TypeError: Failed to fetch' }, vazio('k3'), certo('k3')] });
  assert.strictEqual((await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA })).id, 'k3');
  const p2 = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'k4' }) }, conferencia: [{ status: 0, texto: 'x' }, vazio('k4'), { status: 503, texto: 'x' }] });
  await assert.rejects(() => publicarNaKiwify(p2, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA }), /KIWIFY_SEM_ENTREGA: approved_url vazio/, 'uma leitura legivel sem entrega e nenhuma certa');
});

test('"ja estava na Kiwify" tambem espera e repete antes de concluir', async () => {
  const p = paginaFalsa({ produtos: [{ id: 'j5', name: 'Livro Novo' }], conferencia: [vazio('j5'), certo('j5')] });
  // sem ao_buscar_id, a 1a leitura e a do proprio fake (entregaInicial vazio): vazia, depois certa
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.deepStrictEqual([r.jaExistia, r.id], [true, 'j5']);
});

test('sem esperar injetado, a conferencia usa as esperas medidas', () => {
  assert.deepStrictEqual(require('../src/agents/publisherKiwify').ESPERAS_CONFERENCIA_MS, [1500, 3000, 6000]);
});


// ── 15/10/2026: a entrega mora em json.checkout, AO LADO de json.product ──

test('forma real da resposta: approved_url em checkout e plano em links, fora de product', async () => {
  const real = id => ({ status: 200, texto: JSON.stringify({
    product: { id, name: 'Livro Novo', status: 'active', price: 499 },
    checkout: { approved_url: ENTREGA, payment_methods: 3 },
    links: [{ id: 'aBc1234', type: 'plan', status: 'active', private: false }],
    settings: { currency: 'BRL' },
  }) });
  const p = paginaFalsa({ criar: { status: 200, texto: JSON.stringify({ id: 'r1' }) }, conferencia: real('r1') });
  const r = await publicarNaKiwify(p, LIVRO, { cred: CRED, esperarConferencia: SEM_ESPERA });
  assert.strictEqual(r.id, 'r1', 'a entrega no checkout ao lado conta');
  assert.strictEqual(r.checkout, 'https://pay.kiwify.com.br/aBc1234', 'o plano em links tambem');
});
