'use strict';
/**
 * O produto "e-book + audiolivro": quem vira produto, o texto ao leitor (sem
 * promessa e sem dizer como o audio foi feito), o PDF com o link assinado do
 * MP3 do ORIGINAL na pagina 2, e a idempotencia do script.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const a = require('../src/ferramentas/audiolivro');
const { quebrarLink, quebrarFrase } = require('../src/ferramentas/combo');
const script = require('../scripts/criarAudiolivros');

const ORIG = { id: 'orig-0001', title: 'Liderança Prática', language: 'pt-BR', combo_de: null, audio_de: null };

test('so vira produto o MP3 completo de livro avulso com PDF', () => {
  const ok = { original: ORIG, duracaoS: 2880, temPdf: true, jaExiste: false };
  assert.strictEqual(a.motivoParaNaoCriar(ok), null);
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, duracaoS: 899 }), 'audio-curto', '14 min e 59 s: pedaco do livro, nao o livro');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, duracaoS: 900 }), null, '15 min exatos entram');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, duracaoS: NaN }), 'audio-curto', 'duracao que nao se mede nao entra');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, original: null }), 'sem-livro');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, original: { ...ORIG, combo_de: 'x' } }), 'original-e-combo');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, original: { ...ORIG, audio_de: 'x' } }), 'original-e-audiolivro');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, jaExiste: true }), 'ja-existe');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, temPdf: false }), 'sem-pdf');
  assert.strictEqual(a.motivoParaNaoCriar({ ...ok, original: { ...ORIG, language: 'ja' } }), 'idioma-sem-fonte',
    'japones nao cabe na fonte da pagina de acesso');
  assert.strictEqual(a.DURACAO_MINIMA_S, 900);
  assert.strictEqual(a.PRECO_AUDIOLIVRO, 9.9, 'preco decidido pelo dono');
});

test('idioma: duas letras, padrao portugues, e so os que a fonte escreve', () => {
  assert.strictEqual(a.idiomaDoAudiolivro('pt-BR'), 'pt');
  assert.strictEqual(a.idiomaDoAudiolivro(null), 'pt');
  assert.strictEqual(a.idiomaDoAudiolivro('FR'), 'fr');
  assert.strictEqual(a.idiomaDoAudiolivro('zh-CN'), null);
  assert.strictEqual(a.idiomaDoAudiolivro('pl'), null);
  assert.strictEqual(a.minutos(2880), 48);
  assert.strictEqual(a.minutos('x'), 1);
});

test('titulo leva o sufixo do idioma, nunca cortado, e cabe nos 100 da Kiwify', () => {
  assert.strictEqual(a.tituloDoAudiolivro('Liderança Prática', 'pt-BR'), 'Liderança Prática + Audiolivro');
  assert.strictEqual(a.tituloDoAudiolivro('Focus', 'en'), 'Focus + Audiobook');
  const longo = a.tituloDoAudiolivro('T'.repeat(150), 'pt');
  assert.strictEqual(longo.length, 100, 'cortado no titulo, no limite em que a Kiwify guarda');
  assert.ok(longo.endsWith(' + Audiolivro'));
});

test('descricao e pagina de acesso: o que o comprador recebe, sem promessa e sem dizer como foi feito', () => {
  for (const lang of ['pt', 'en', 'es', 'fr', 'de', 'it', 'nl']) {
    const d = a.descricaoDoAudiolivro('Texto do livro.', 2880, lang);
    assert.match(d, /^Texto do livro\.\n\n/);
    assert.match(d, /48/, lang + ': diz quantos minutos');
    assert.match(d, /MP3/);
    assert.ok(!/\bIA\b|\bAI\b|intelig|artific|sint[eé]t|synth|robô|robot|garant|resultado|guarantee/i.test(d), lang + ': nada de IA nem promessa');
    const t = a.textoDaPaginaDoAudio('Livro “X”', 'https://h/audio/t', 2880, lang);
    const tudo = [t.cabecalho, ...t.linhas, t.rodape].join(' ');
    assert.ok(!/\bIA\b|\bAI\b|intelig|artific|sint[eé]t|synth/i.test(tudo), lang + ': pagina sem IA');
    assert.strictEqual(t.link, 'https://h/audio/t');
    assert.match(t.rodape, /Livro "X"/, 'titulo na fonte do PDF');
    assert.match(t.linhas.join(' '), /48/);
  }
  assert.match(a.descricaoDoAudiolivro(null, 600, 'pt'), /^Inclui a versão em áudio/, 'sem descricao, so o audio');
  assert.strictEqual(a.textoDaPaginaDoAudio('X', null, 60, 'xx').cabecalho, 'Seu Audiolivro', 'idioma desconhecido cai no portugues');
});

test('quebra de link e de frase na largura da pagina', () => {
  const medir = s => s.length;
  assert.deepStrictEqual(quebrarLink('abcdefghij', 4, medir), ['abcd', 'efgh', 'ij']);
  assert.deepStrictEqual(quebrarLink('abc', 4, medir), ['abc']);
  assert.deepStrictEqual(quebrarLink('', 4, medir), []);
  assert.deepStrictEqual(quebrarFrase('um dois tres quatro', 8, medir), ['um dois', 'tres', 'quatro']);
  assert.deepStrictEqual(quebrarFrase('palavragrande x', 5, medir), ['palavragrande', 'x'], 'palavra maior que a linha fica inteira');
  assert.deepStrictEqual(quebrarFrase('', 5, medir), [''], 'linha vazia continua sendo espaco');
});

async function pdfDeTeste(largura = 420) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) doc.addPage([largura, 595]).drawText('Pagina original ' + (i + 1), { x: 30, y: 500, size: 14, font: f });
  return doc.save();
}

function banco() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT PRIMARY KEY, topic TEXT, title TEXT, subtitle TEXT, description TEXT, cover_path TEXT, ' +
    'pdf_path TEXT, status TEXT, price REAL, ai_provider TEXT, language TEXT, word_count INTEGER, combo_de TEXT)');
  return db;
}

test('script: cria a linha, o PDF com o link do MP3 do ORIGINAL na pagina 2, e e idempotente', async () => {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolivro-'));
  const pdfOrig = path.join(dir, 'orig.pdf');
  // Pagina estreita (formato de bolso): o link comprido tem de quebrar, nao sair da margem.
  fs.writeFileSync(pdfOrig, await pdfDeTeste(300));
  const db = banco();
  const ins = db.prepare('INSERT INTO ebooks (id, topic, title, description, cover_path, pdf_path, price, language, word_count, combo_de) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('orig-0001', 'lid', 'Liderança Prática', 'Descricao do livro original.', '/c.jpg', pdfOrig, 4.99, 'pt-BR', 9000, null);
  ins.run('orig-curto', 'x', 'Curto', 'd', null, pdfOrig, 4.99, 'pt', 0, null);
  ins.run('orig-combo', 'x', 'Combo', 'd', null, pdfOrig, 19.9, 'pt', 0, 'algum');
  ins.run('orig-sempdf', 'x', 'Sem PDF', 'd', null, path.join(dir, 'sumiu.pdf'), 4.99, 'pt', 0, null);
  const urls = [];
  const deps = {
    dir,
    medir: arq => (arq.includes('orig-curto') ? 312 : 2880),
    urlAudio: id => { const u = 'https://publisher.veloxisit.com.br/audio/' + id + '.' + 'A'.repeat(32) + 'B'.repeat(40); urls.push(u); return u; },
    seco: false,
  };
  const r = await script.principal({ db, limite: 10, ids: ['orig-0001', 'orig-curto', 'orig-combo', 'orig-sempdf', 'nao-existe'], deps });
  assert.deepStrictEqual({ ...r, motivos: undefined }, { mp3: 5, criados: 1, jaExistiam: 0, pulados: 4, falhas: 0, motivos: undefined });
  assert.deepStrictEqual(r.motivos, { 'audio-curto': 1, 'original-e-combo': 1, 'sem-pdf': 1, 'sem-livro': 1 });
  assert.deepStrictEqual(urls, ['https://publisher.veloxisit.com.br/audio/orig-0001.' + 'A'.repeat(32) + 'B'.repeat(40)], 'link do MP3 do original');

  const novo = db.prepare('SELECT * FROM ebooks WHERE audio_de = ?').get('orig-0001');
  assert.ok(novo, 'linha nova ligada pelo audio_de');
  assert.strictEqual(novo.combo_de, null, 'combo_de vazio: o livro continua podendo ganhar o combo do plano de acao');
  assert.strictEqual(novo.title, 'Liderança Prática + Audiolivro');
  assert.strictEqual(novo.price, 9.9);
  assert.strictEqual(novo.status, 'ready');
  assert.strictEqual(novo.language, 'pt-BR');
  assert.strictEqual(novo.cover_path, '/c.jpg');
  assert.match(novo.description, /^Descricao do livro original\.\n\nInclui a versão em áudio narrada do livro completo, com cerca de 48 minutos/);
  assert.notStrictEqual(novo.pdf_path, pdfOrig, 'o PDF original nao e tocado');
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.tmp')), 'nenhum temporario sobrou');

  const doc = await PDFDocument.load(fs.readFileSync(novo.pdf_path));
  assert.strictEqual(doc.getPageCount(), 4);
  const anots = doc.getPage(1).node.lookup(PDFName.of('Annots'));
  assert.ok(anots.size() >= 2, 'link comprido em pagina estreita quebrou em mais de uma linha');
  for (let i = 0; i < anots.size(); i++) {
    const uri = anots.lookup(i).lookup(PDFName.of('A')).lookup(PDFName.of('URI')).decodeText();
    assert.strictEqual(uri, urls[0], 'cada pedaco leva o link INTEIRO');
    const rect = anots.lookup(i).lookup(PDFName.of('Rect')).asArray().map(n => n.asNumber());
    assert.ok(rect[2] <= 300 - 56 + 0.01, 'o link nao passa da margem direita');
  }
  const { lerPdf } = require('../src/agents/qualityAgent');
  const texto = (await lerPdf(fs.readFileSync(novo.pdf_path))).text;
  assert.match(texto, /Pagina original 1[\s\S]*Seu Audiolivro[\s\S]*Pagina original 2/);

  // Segunda rodada: nada novo.
  const r2 = await script.principal({ db, limite: 10, ids: ['orig-0001'], deps });
  assert.strictEqual(r2.criados, 0);
  assert.strictEqual(r2.jaExistiam, 1);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM ebooks WHERE audio_de IS NOT NULL').get().n, 1);
  // O proprio audiolivro nunca vira audiolivro de novo.
  assert.strictEqual((await script.criarUm(db, novo.id, deps)).estado, 'original-e-audiolivro');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: limite conta criados, dry-run nao grava, falha de um nao derruba os outros', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolivro-'));
  const pdfOrig = path.join(dir, 'o.pdf');
  fs.writeFileSync(pdfOrig, await pdfDeTeste());
  const db = banco();
  const ins = db.prepare('INSERT INTO ebooks (id, title, description, pdf_path, language) VALUES (?,?,?,?,?)');
  for (const id of ['livro-01', 'livro-02', 'livro-03', 'livro-04']) ins.run(id, 'Livro ' + id, 'd', pdfOrig, 'en');
  const base = { dir, medir: () => 3000, urlAudio: id => 'https://h/audio/' + id };

  const seco = await script.principal({ db, limite: 10, ids: ['livro-01'], deps: { ...base, seco: true } });
  assert.strictEqual(seco.criados, 1);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM ebooks WHERE audio_de IS NOT NULL').get().n, 0, 'dry-run nao grava linha');
  assert.strictEqual(fs.readdirSync(dir).length, 1, 'nem PDF');

  const medir = arq => { if (arq.includes('livro-02')) throw new Error('ffprobe caiu'); return 3000; };
  const r = await script.principal({ db, limite: 2, ids: ['livro-01', 'livro-02', 'livro-03', 'livro-04'], deps: { ...base, medir, seco: false } });
  assert.strictEqual(r.falhas, 1);
  assert.strictEqual(r.criados, 1, 'o limite conta criados + falhas: parou no segundo');
  const r2 = await script.principal({ db, limite: 5, ids: ['livro-03', 'livro-04'], deps: { ...base, seco: false } });
  assert.strictEqual(r2.criados, 2);
  const t = db.prepare("SELECT title FROM ebooks WHERE audio_de = 'livro-03'").get().title;
  assert.strictEqual(t, 'Livro livro-03 + Audiobook', 'sufixo no idioma do livro');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: le os ids da pasta (o de dominio publico fica de fora) e mede pelo ffprobe', () => {
  const ids = script.idsComAudio('/x', () => ['b-00000001.mp3', 'gutenberg-1342.mp3', 'a-00000002.mp3', 'nota.txt', '../x.mp3']);
  assert.deepStrictEqual(ids, ['a-00000002', 'b-00000001']);
  let chamada;
  const s = script.duracaoDoMp3('/x/a.mp3', (cmd, args) => { chamada = [cmd, ...args]; return ' 2880.5\n'; });
  assert.strictEqual(s, 2880.5);
  assert.deepStrictEqual(chamada, ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '/x/a.mp3']);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE ebooks (id TEXT)');
  script.prepararBanco(db);
  script.prepararBanco(db);
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  assert.ok(cols.includes('audio_de') && cols.includes('combo_de'), 'colunas criadas uma vez, sem erro na segunda');
});

test('no A4 o link do audio (110 caracteres) cabe numa linha so, com letra menor', async () => {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const url = 'https://publisher.veloxisit.com.br/audio/0c104665-ee04-4964-aab3-e781471f1247.' + 'A'.repeat(32);
  const texto = a.textoDaPaginaDoAudio('Livro', url, 2880, 'pt');
  const doc = await PDFDocument.load(await require('../src/ferramentas/combo').montarPdfDoCombo(await pdfDeTeste(595.28), { titulo: 'Livro', url, texto }));
  const anots = doc.getPage(1).node.lookup(PDFName.of('Annots'));
  assert.strictEqual(anots.size(), 1, 'uma linha, sem sobrar um caractere sozinho na seguinte');
  const rect = anots.lookup(0).lookup(PDFName.of('Rect')).asArray().map(n => n.asNumber());
  assert.ok(rect[2] <= 595.28 - 56 + 0.01, 'dentro da margem');
});
