// Travas da publicacao em lote.
//
// Cada bloco aqui existe por causa de um estrago que JA aconteceu em producao,
// e o teste reproduz exatamente a condicao que o causou. Nenhum caso e
// hipotetico.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

const {
  sessaoMorta, comLimite, reservar, liberar, garantirTabela,
} = require('../src/agents/publishBacklog');

// ── sessaoMorta ─────────────────────────────────────────────────────────────
// Um lote de 12 itens gastou 13 minutos para publicar ZERO: a sonda de sessao
// dizia `true` (o TGT era valido no CAS) mas o wizard caia no SSO, e cada item
// esperava 90s por uma tela que nunca renderiza.

test('sessaoMorta reconhece a queda no SSO pelo proprio erro do wizard', () => {
  assert.equal(sessaoMorta('eBook card not found after 90s -- wizard not rendered. URL: https://sso.hotmart.com/login?service=x'), true);
});

test('sessaoMorta reconhece "wizard not rendered" mesmo sem a URL', () => {
  assert.equal(sessaoMorta('eBook card not found after 90s -- wizard not rendered.'), true);
});

test('sessaoMorta reconhece o codigo que a propria sonda devolve', () => {
  assert.equal(sessaoMorta('SESSAO_EXPIRADA_LOGIN_HUMANO'), true);
});

test('sessaoMorta NAO aborta por falha isolada de um item', () => {
  // Abortar o lote inteiro por causa de um PDF corrompido descartaria 11 itens
  // publicaveis. So sinal de SESSAO aborta.
  assert.equal(sessaoMorta('PDF not found: /app/data/pdfs/x.pdf'), false);
  assert.equal(sessaoMorta('Pricing save timeout'), false);
  assert.equal(sessaoMorta('rascunho criado (id=123), aguardando finalizacao'), false);
});

test('sessaoMorta tolera entrada vazia sem quebrar', () => {
  for (const v of [null, undefined, '', 0, {}]) assert.equal(sessaoMorta(v), false);
});

// ── comLimite ───────────────────────────────────────────────────────────────

test('comLimite respeita o teto de simultaneidade', async () => {
  let ativos = 0, pico = 0;
  const itens = Array.from({ length: 9 }, (_, i) => i);
  await comLimite(itens, 3, async () => {
    ativos++; pico = Math.max(pico, ativos);
    await new Promise(r => setTimeout(r, 12));
    ativos--;
    return 'ok';
  });
  assert.equal(pico, 3, 'nunca deve passar de 3 simultaneos');
});

test('comLimite processa TODOS os itens, nao so os do primeiro bloco', async () => {
  const vistos = [];
  const r = await comLimite([1, 2, 3, 4, 5, 6, 7], 2, async n => { vistos.push(n); return n * 2; });
  assert.equal(vistos.length, 7);
  assert.deepEqual(r, [2, 4, 6, 8, 10, 12, 14]);
});

test('comLimite isola a excecao de um item e segue com os outros', async () => {
  // Um item que lanca nao pode derrubar o lote — foi assim que 11 e-books
  // ficaram sem sequer uma linha de log.
  const r = await comLimite([1, 2, 3], 2, async n => {
    if (n === 2) throw new Error('estourou');
    return n;
  });
  assert.equal(r[0], 1);
  assert.equal(r[1].ok, false);
  assert.match(r[1].motivo, /estourou/);
  assert.equal(r[2], 3);
});

test('comLimite com lista vazia devolve vazio sem travar', async () => {
  assert.deepEqual(await comLimite([], 3, async () => 'x'), []);
});

test('comLimite com paralelo maior que a lista nao cria trabalhador ocioso', async () => {
  const r = await comLimite([1, 2], 10, async n => n);
  assert.deepEqual(r, [1, 2]);
});

// ── reserva atomica ─────────────────────────────────────────────────────────
// O e-book abaee126 ("Investir em Acoes com R$100") virou DOIS produtos no
// Hotmart (8419956 e 8419962) porque dois lotes selecionaram o mesmo candidato.

function dbTemp() {
  const f = path.join(os.tmpdir(), 'pb-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.db');
  const db = new Database(f);
  garantirTabela(db);
  return { db, f };
}

test('reservar concede ao primeiro e recusa ao segundo', () => {
  const { db, f } = dbTemp();
  try {
    assert.equal(reservar(db, 'ebook-A', 'hotmart'), true,  'o primeiro leva');
    assert.equal(reservar(db, 'ebook-A', 'hotmart'), false, 'o segundo tem de ser recusado');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('a reserva e por plataforma: publicar no Cakto nao bloqueia o Hotmart', () => {
  const { db, f } = dbTemp();
  try {
    assert.equal(reservar(db, 'ebook-A', 'hotmart'), true);
    assert.equal(reservar(db, 'ebook-A', 'cakto'), true, 'plataformas sao filas independentes');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('liberar devolve o item para a fila apos falha', () => {
  const { db, f } = dbTemp();
  try {
    reservar(db, 'ebook-B', 'hotmart');
    liberar(db, 'ebook-B', 'hotmart');
    assert.equal(reservar(db, 'ebook-B', 'hotmart'), true, 'falha nao pode prender o item ate expirar');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('reserva vencida e recolhida — item nao vaza quando o lote morre no meio', () => {
  // Um lote ja foi morto por SIGTERM com itens reservados. Sem expiracao esses
  // e-books ficariam invisiveis para sempre.
  const { db, f } = dbTemp();
  try {
    const velho = Date.now() - 31 * 60 * 1000;   // 31 min: alem do teto de 30
    db.prepare('INSERT INTO publish_claims (chave, quando) VALUES (?, ?)').run('hotmart:ebook-C', velho);
    assert.equal(reservar(db, 'ebook-C', 'hotmart'), true, 'reserva vencida deve ser recolhida');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('reserva recente NAO e recolhida', () => {
  const { db, f } = dbTemp();
  try {
    const recente = Date.now() - 60 * 1000;      // 1 min
    db.prepare('INSERT INTO publish_claims (chave, quando) VALUES (?, ?)').run('hotmart:ebook-D', recente);
    assert.equal(reservar(db, 'ebook-D', 'hotmart'), false, 'lote em andamento nao pode perder o item');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('garantirTabela e idempotente — roda a cada lote', () => {
  const { db, f } = dbTemp();
  try {
    garantirTabela(db); garantirTabela(db);
    assert.equal(reservar(db, 'ebook-E', 'hotmart'), true);
  } finally { db.close(); fs.unlinkSync(f); }
});

test('reservar nao lanca quando o banco esta em somente-leitura', () => {
  // O agente nunca pode morrer por causa da reserva; no pior caso ele publica
  // sem a trava, que era o comportamento anterior.
  const { db, f } = dbTemp();
  db.close();
  const ro = new Database(f, { readonly: true });
  try {
    assert.doesNotThrow(() => liberar(ro, 'x', 'hotmart'));
  } finally { ro.close(); fs.unlinkSync(f); }
});

// ── contador de falhas ──────────────────────────────────────────────────────
// Titulos em japones e chines falham SEMPRE com "No product ID after creation".
// Sem contador eles voltam em todo lote e queimam uma vaga de 90s, para sempre.

const { registrarFalha, esgotado, garantirTabelaFalhas } = require('../src/agents/publishBacklog');

function dbFalhas() {
  const f = path.join(os.tmpdir(), 'pf-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.db');
  const db = new Database(f);
  garantirTabelaFalhas(db);
  return { db, f };
}

test('item so e descartado depois de falhar 3 vezes', () => {
  const { db, f } = dbFalhas();
  try {
    registrarFalha(db, 'e1', 'hotmart', 'No product ID after creation');
    assert.equal(esgotado(db, 'e1', 'hotmart'), false, 'uma falha pode ser transitoria');
    registrarFalha(db, 'e1', 'hotmart', 'No product ID after creation');
    assert.equal(esgotado(db, 'e1', 'hotmart'), false);
    registrarFalha(db, 'e1', 'hotmart', 'No product ID after creation');
    assert.equal(esgotado(db, 'e1', 'hotmart'), true, 'na terceira sai de circulacao');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('FALHA DE SESSAO NAO CONTA — senao um apagao envenena o backlog inteiro', () => {
  // Este e o caso que decide se o contador presta. Uma sessao expirada derruba
  // os 12 itens do lote; se pontuasse, tres apagoes tirariam de circulacao
  // e-books perfeitamente publicaveis e o sistema pararia sozinho.
  const { db, f } = dbFalhas();
  try {
    for (let i = 0; i < 8; i++) registrarFalha(db, 'e2', 'hotmart', 'SESSAO_EXPIRADA_LOGIN_HUMANO');
    assert.equal(esgotado(db, 'e2', 'hotmart'), false);
    for (let i = 0; i < 8; i++) {
      registrarFalha(db, 'e2', 'hotmart', 'eBook card not found after 90s -- wizard not rendered. URL: https://sso.hotmart.com/login');
    }
    assert.equal(esgotado(db, 'e2', 'hotmart'), false, 'queda no SSO tambem e ambiente, nao o e-book');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('o contador e por plataforma', () => {
  const { db, f } = dbFalhas();
  try {
    for (let i = 0; i < 3; i++) registrarFalha(db, 'e3', 'hotmart', 'erro proprio');
    assert.equal(esgotado(db, 'e3', 'hotmart'), true);
    assert.equal(esgotado(db, 'e3', 'cakto'), false, 'falhar no Hotmart nao impede o Cakto');
  } finally { db.close(); fs.unlinkSync(f); }
});

test('item nunca visto nao esta esgotado', () => {
  const { db, f } = dbFalhas();
  try { assert.equal(esgotado(db, 'nunca-visto', 'hotmart'), false); }
  finally { db.close(); fs.unlinkSync(f); }
});

test('registrarFalha nunca lanca — contador e otimizacao, nao pode derrubar o lote', () => {
  const { db, f } = dbFalhas();
  db.close();
  const ro = new Database(f, { readonly: true });
  try { assert.doesNotThrow(() => registrarFalha(ro, 'x', 'hotmart', 'erro')); }
  finally { ro.close(); fs.unlinkSync(f); }
});
