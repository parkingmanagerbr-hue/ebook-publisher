// Travas do reenvio de capas.
//
// O passivo foi visto A OLHO: dos 12 primeiros produtos da lista do Hotmart, 11
// com placeholder cinza. Reenviar capa e uma acao que TOCA A CONTA — reenviar o
// que ja esta certo gasta tempo e risco a toa, e pular o que falta deixa o
// produto competindo com um icone generico. Por isso a selecao tem teste.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

const { buscarCandidatos, garantirTabela, jaTentado, registrar } = require('../src/agents/backfillCovers');

function bancoTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  const db = new Database(path.join(dir, 't.db'));
  db.prepare(
    'CREATE TABLE ebooks (id TEXT, title TEXT, hotmart_product_id TEXT, cover_path TEXT)'
  ).run();
  garantirTabela(db);
  return { db, dir };
}

function capaFalsa(dir, nome) {
  const p = path.join(dir, nome);
  fs.writeFileSync(p, 'png-falso');
  return p;
}

function inserir(db, id, produto, capa, titulo) {
  db.prepare('INSERT INTO ebooks (id, title, hotmart_product_id, cover_path) VALUES (?,?,?,?)')
    .run(id, titulo || ('t-' + id), produto, capa);
}

test('seleciona produto publicado cuja capa existe em disco', () => {
  const { db, dir } = bancoTemp();
  try {
    inserir(db, 'e1', '8420416', capaFalsa(dir, 'c1.png'));
    const r = buscarCandidatos(db, 10);
    assert.equal(r.length, 1);
    assert.equal(r[0].numericId, '8420416');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ignora e-book que nunca foi publicado no Hotmart', () => {
  // Sem produto no ar nao ha onde enviar capa; isso e trabalho do publisher.
  const { db, dir } = bancoTemp();
  try {
    inserir(db, 'e1', null, capaFalsa(dir, 'c1.png'));
    inserir(db, 'e2', '', capaFalsa(dir, 'c2.png'));
    assert.equal(buscarCandidatos(db, 10).length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ignora produto cuja capa a retencao ja apagou do disco', () => {
  // Enviar caminho inexistente falharia no navegador depois de dezenas de
  // segundos; barrar aqui custa uma chamada de stat.
  const { db, dir } = bancoTemp();
  try {
    inserir(db, 'e1', '111', path.join(dir, 'nao-existe.png'));
    assert.equal(buscarCandidatos(db, 10).length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nao repete produto ja processado', () => {
  const { db, dir } = bancoTemp();
  try {
    inserir(db, 'e1', '222', capaFalsa(dir, 'c1.png'));
    registrar(db, '222', true);
    assert.equal(buscarCandidatos(db, 10).length, 0, 'reenviar capa certa e desperdicio');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nao repete nem quando a tentativa anterior FALHOU', () => {
  // Insistir automaticamente no mesmo produto que ja falhou faria o lote girar
  // em falso sobre os mesmos itens, sem nunca alcancar os demais.
  const { db, dir } = bancoTemp();
  try {
    inserir(db, 'e1', '333', capaFalsa(dir, 'c1.png'));
    registrar(db, '333', false);
    assert.equal(buscarCandidatos(db, 10).length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('respeita o limite pedido', () => {
  const { db, dir } = bancoTemp();
  try {
    for (let i = 0; i < 12; i++) inserir(db, 'e' + i, '90' + i, capaFalsa(dir, 'c' + i + '.png'));
    assert.equal(buscarCandidatos(db, 5).length, 5);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('varre alem do limite para nao devolver lote curto por causa de descartes', () => {
  // Se a busca lesse exatamente `limite` linhas e metade fosse descartada, o
  // lote sairia pela metade e o passivo nunca acabaria.
  const { db, dir } = bancoTemp();
  try {
    for (let i = 0; i < 10; i++) inserir(db, 'x' + i, '80' + i, path.join(dir, 'sumiu' + i + '.png'));
    for (let i = 0; i < 4; i++) inserir(db, 'ok' + i, '70' + i, capaFalsa(dir, 'ok' + i + '.png'));
    assert.equal(buscarCandidatos(db, 3).length, 3, 'os validos estao atras dos invalidos e devem ser alcancados');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('jaTentado distingue processado de nunca visto', () => {
  const { db, dir } = bancoTemp();
  try {
    assert.equal(jaTentado(db, '999'), false);
    registrar(db, '999', true);
    assert.equal(jaTentado(db, '999'), true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('registrar sobrescreve em vez de duplicar a chave', () => {
  const { db, dir } = bancoTemp();
  try {
    registrar(db, '555', false);
    registrar(db, '555', true);
    const n = db.prepare('SELECT COUNT(*) c FROM cover_backfill WHERE produto = ?').get('555').c;
    assert.equal(n, 1);
    assert.equal(db.prepare('SELECT ok FROM cover_backfill WHERE produto = ?').get('555').ok, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('garantirTabela e idempotente', () => {
  const { db, dir } = bancoTemp();
  try {
    garantirTabela(db); garantirTabela(db);
    assert.doesNotThrow(() => registrar(db, '1', true));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('alcanca os pendentes ANTIGOS mesmo com a janela cheia de ja-processados', () => {
  // O bug real: o descarte de processados acontecia so em JS, depois da leitura.
  // A janela (limite*6 linhas mais recentes) enchia de itens ja feitos e a
  // funcao devolvia ZERO — o cron anunciava "nenhum produto pendente" com ~600
  // produtos ainda sem capa, e os antigos nunca seriam alcancados.
  const { db, dir } = bancoTemp();
  try {
    // 40 recentes ja processados ficam a FRENTE na ordem rowid DESC...
    for (let i = 0; i < 40; i++) {
      inserir(db, 'novo' + i, '90' + i, capaFalsa(dir, 'n' + i + '.png'));
    }
    // ...e o pendente de verdade fica atras (inserido antes = rowid menor).
    // Reinsere na ordem correta: o pendente primeiro.
    db.prepare('DELETE FROM ebooks').run();
    inserir(db, 'antigo', '7777', capaFalsa(dir, 'antigo.png'), 'O que falta capa');
    for (let i = 0; i < 40; i++) {
      inserir(db, 'novo' + i, '90' + i, capaFalsa(dir, 'n' + i + '.png'));
      registrar(db, '90' + i, true);
    }
    const r = buscarCandidatos(db, 5);
    assert.equal(r.length, 1, 'o pendente antigo tem de ser alcancado');
    assert.equal(r[0].numericId, '7777');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
