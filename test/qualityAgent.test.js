'use strict';
/**
 * qualityAgent: o portao entre o gerador e a loja. Capa preta, placeholder de
 * 2 KB ou PDF de 3 paginas nao podem ir para venda; capa boa nao pode ser
 * jogada fora (cada regeracao gasta cota de imagem).
 *
 * Arquivos REAIS gerados no teste: PNG/JPEG/WebP pelo @napi-rs/canvas e PDF
 * pelo pdfkit. Nada de bytes redigitados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const PDFDocument = require('pdfkit');

const { interceptar, recarregar, semente } = require('./apoio');
const qa = require('../src/agents/qualityAgent');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** Pinta pixel a pixel com a funcao dada e grava no formato pedido. */
async function imagem(nome, w, h, cor, formato = 'png') {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = cor(x, y);
    const i = (y * w + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const p = path.join(DIR, nome);
  fs.writeFileSync(p, await c.encode(formato));
  return p;
}

const rnd = semente(42);
const ruido = amp => Math.floor(rnd() * amp);
// Blocos coloridos de 64 px com ruido fino: variado, escuro, sem cara de UI e pesado o bastante.
const artistica = (x, y) => {
  const bloco = ((Math.floor(x / 64) * 7 + Math.floor(y / 64) * 13) % 11) * 12;
  return [40 + bloco + ruido(20), 60 + (bloco / 2) + ruido(20), 90 + ruido(20)];
};

test('capa boa (PNG, JPEG e WebP reais, variada e pesada) e aprovada', async () => {
  for (const fmt of ['png', 'jpeg', 'webp']) {
    const p = await imagem('boa.' + fmt, 1024, 1024, artistica, fmt);
    const r = await qa.checkImage(p, { label: 'capa' });
    assert.deepStrictEqual(r.issues, [], fmt);
    assert.strictEqual(r.ok, true, fmt);
    assert.ok(r.sizeKb >= 30 && r.stdDev >= 15);
  }
});

test('REGRESSAO: WebP valido nao e reprovado por "magic bytes"', async () => {
  // O cabecalho lido tinha 8 bytes e a checagem olhava buf[8] e buf[9]
  // (sempre undefined): toda capa WebP virava "nao e imagem valida" e era
  // regerada ate estourar as tentativas.
  const p = await imagem('capa.webp', 1024, 1024, artistica, 'webp');
  const r = await qa.checkImage(p, { label: 'capa' });
  assert.ok(!r.issues.some(i => /magic bytes/.test(i)), r.issues.join('; '));
});

test('arquivo que nao existe, placeholder pequeno e arquivo que nao e imagem', async () => {
  assert.deepStrictEqual(await qa.checkImage(path.join(DIR, 'nada.png')), { ok: false, issues: ['imagem: arquivo não encontrado'] });

  const pequeno = await imagem('peq.png', 64, 64, artistica);
  const r1 = await qa.checkImage(pequeno, { label: 'capa' });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.issues[0], /tamanho muito pequeno/);

  const falso = path.join(DIR, 'falso.png');
  fs.writeFileSync(falso, Buffer.alloc(40 * 1024, 65));
  const r2 = await qa.checkImage(falso, { label: 'capa' });
  assert.ok(r2.issues.some(i => /magic bytes/.test(i)));
  assert.ok(r2.issues.some(i => /não foi possível ler pixels/.test(i)));
});

test('RIFF que nao e WebP (ex.: WAV) continua reprovado (controle)', async () => {
  const wav = path.join(DIR, 'som.png');
  const b = Buffer.alloc(40 * 1024);
  b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii');
  fs.writeFileSync(wav, b);
  assert.ok((await qa.checkImage(wav)).issues.some(i => /magic bytes/.test(i)));
});

test('caminho que e diretorio: nao e imagem valida', async () => {
  const d = path.join(DIR, 'pasta.png');
  fs.mkdirSync(d);
  const r = await qa.checkImage(d);
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(i => /magic bytes/.test(i)));
});

test('imagem quase toda preta ou toda branca e reprovada e o motivo diz qual', async () => {
  const preta = await imagem('preta.png', 512, 512, () => [ruido(8), ruido(8), ruido(8)]);
  const branca = await imagem('branca.png', 512, 512, () => [247 + ruido(8), 247 + ruido(8), 247 + ruido(8)]);
  assert.match((await qa.checkImage(preta)).issues.join(), /uniformemente preta/);
  assert.match((await qa.checkImage(branca)).issues.join(), /uniformemente branca/);
});

test('ilustracao com fundo claro (mockup de tela) ou texto demais e reprovada; artistica passa', async () => {
  const ui = await imagem('ui.png', 1600, 900, (x, y) => (y < 120 || x < 200 ? [30 + ruido(30), 30, 80] : [235 + ruido(20), 235 + ruido(20), 235 + ruido(20)]));
  const listras = await imagem('texto.png', 1600, 900, x => (Math.floor(x / 10) % 2 ? [150 + ruido(10), 150, 150] : [ruido(10), 0, 0]));
  const arte = await imagem('arte.png', 1600, 900, artistica);
  assert.match((await qa.checkImage(ui, { label: 'ilustração "Cap 1"' })).issues.join(), /elementos de UI/);
  assert.match((await qa.checkImage(listras, { label: 'ilustração "Cap 2"' })).issues.join(), /elementos de UI/);
  assert.strictEqual((await qa.checkImage(arte, { label: 'ilustração "Cap 3"' })).ok, true);
  assert.strictEqual((await qa.checkImage(ui, { label: 'capa' })).ok, true, 'na capa fundo claro e permitido');
});

test('se a segunda leitura da ilustracao falhar, a checagem de UI nao reprova', async t => {
  const real = require('@napi-rs/canvas');
  let leituras = 0;
  interceptar(t, { '@napi-rs/canvas': { ...real, loadImage: async p => { if (++leituras === 2) throw new Error('arquivo trocado'); return real.loadImage(p); } } });
  const mod = recarregar('src/agents/qualityAgent.js');
  t.after(() => recarregar('src/agents/qualityAgent.js'));
  const arte = await imagem('arte2.png', 1024, 1024, artistica);
  assert.strictEqual((await mod.checkImage(arte, { label: 'ilustração "x"' })).ok, true);
});

// ── retries ─────────────────────────────────────────────────────────────────

test('capa: aprovada na primeira nao regenera', async () => {
  const boa = await imagem('c1.png', 1024, 1024, artistica);
  let n = 0;
  assert.strictEqual(await qa.ensureQualityCover(async () => { n++; return boa; }, 't', 's', 'x'), boa);
  assert.strictEqual(n, 1);
});

test('capa: reprovada e apagada, regenera e aprova; gerador que lanca tenta de novo', async () => {
  const ruim = await imagem('ruim.png', 64, 64, () => [0, 0, 0]);
  const boa = await imagem('c2.png', 1024, 1024, artistica);
  const seq = [() => ruim, () => { throw new Error('FX 429'); }, () => boa];
  const argumentos = [];
  const r = await qa.ensureQualityCover(async (...a) => { argumentos.push(a); return seq.shift()(); }, 'Titulo', 'Sub', 'Tema');
  assert.strictEqual(r, boa);
  assert.ok(!fs.existsSync(ruim), 'capa reprovada e apagada');
  assert.deepStrictEqual(argumentos[0], ['Titulo', 'Sub', 'Tema']);
});

test('capa: tres reprovacoes lancam; erro do gerador na ultima tentativa propaga', async () => {
  let n = 0;
  await assert.rejects(() => qa.ensureQualityCover(async () => { n++; return path.join(DIR, 'nunca-existiu.png'); }), /falhou no QA após 3 tentativas/);
  assert.strictEqual(n, 3);
  await assert.rejects(() => qa.ensureQualityCover(async () => { throw new Error('sem cota'); }), /sem cota/);
});

test('ilustracao: opcional — sem imagem, erro na ultima ou reprovada 3x devolve null', async () => {
  const boa = await imagem('il.png', 1024, 1024, artistica);
  assert.strictEqual(await qa.ensureQualityIllustration(async () => boa, 'Cap', 't'), boa);
  assert.strictEqual(await qa.ensureQualityIllustration(async () => null, 'Cap', 't'), null);
  assert.strictEqual(await qa.ensureQualityIllustration(async () => { throw new Error('x'); }, 'Cap', 't'), null);
  let n = 0;
  assert.strictEqual(await qa.ensureQualityIllustration(async () => { n++; return path.join(DIR, 'sumiu.png'); }, 'Cap', 't'), null);
  assert.strictEqual(n, 3);
});

// ── validateEbook ───────────────────────────────────────────────────────────

const texto = n => 'a'.repeat(n);

test('e-book completo passa; avisos nao reprovam', async () => {
  const pdf = path.join(DIR, 'ok.pdf'); fs.writeFileSync(pdf, '%PDF-');
  const r = await qa.validateEbook({ title: 'T', introduction: texto(200), conclusion: texto(100), wordCount: 1000,
    chapters: [{ title: 'C1', content: texto(300) }], pdfPath: pdf, coverPath: pdf });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.warnings, ['Subtítulo ausente', 'Descrição ausente', 'Wordcount baixo: 1000 palavras (recomendado: 5000+)']);
  const cheio = await qa.validateEbook({ title: 'T', subtitle: 'S', description: 'D', introduction: texto(200), conclusion: texto(100), wordCount: 6000, chapters: [{ title: 'C', content: texto(300) }] });
  assert.deepStrictEqual([cheio.ok, cheio.warnings], [true, []]);
});

test('e-book reprovado lista cada problema: limites exatos de 200, 100 e 300 caracteres', async () => {
  const r = await qa.validateEbook({ title: '  ', introduction: texto(199), conclusion: texto(99), wordCount: 5000,
    chapters: [{ title: '', content: texto(299) }, { title: 'Ok', content: null }], coverPath: path.join(DIR, 'x.png'), pdfPath: path.join(DIR, 'x.pdf') });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.issues, ['Título ausente ou vazio', 'Introdução muito curta ou ausente', 'Conclusão muito curta ou ausente',
    'Capítulo 1: título ausente', 'Capítulo 1 (""): conteúdo muito curto (299 chars)', 'Capítulo 2 ("Ok"): conteúdo muito curto (0 chars)',
    'Arquivo de capa não encontrado', 'Arquivo PDF não encontrado']);
  const vazio = await qa.validateEbook({});
  assert.ok(vazio.issues.includes('Nenhum capítulo gerado'));
  assert.strictEqual((await qa.validateEbook({ chapters: [] })).issues.includes('Nenhum capítulo gerado'), true);
});

// ── validatePDF ─────────────────────────────────────────────────────────────

function gerarPdf(nome, paginas, { imagemPng, texto: txt = 'Conteudo do capitulo com texto suficiente para contar como pagina real. '.repeat(4) } = {}) {
  return new Promise((resolve, reject) => {
    const p = path.join(DIR, nome);
    // Sem compressao: PDF minusculo comprimido pelo pdfkit quebra o pdf.js antigo do
    // pdf-parse ('bad XRef entry') e a checagem cairia no modo basico.
    const doc = new PDFDocument({ autoFirstPage: false, compress: false });
    const s = fs.createWriteStream(p);
    doc.pipe(s);
    for (let i = 0; i < paginas; i++) {
      doc.addPage();
      doc.text(txt);
      if (imagemPng && i === 0) doc.image(imagemPng, 50, 200, { width: 400 });
    }
    doc.end();
    s.on('finish', () => resolve(p));
    s.on('error', reject);
  });
}

test('PDF real com paginas, peso e texto suficientes passa', async () => {
  const pesada = await imagem('pdfimg.png', 900, 900, (x, y) => [ruido(256), ruido(256), ruido(256)]);
  const p = await gerarPdf('bom.pdf', 8, { imagemPng: pesada });
  const r = await qa.validatePDF(p, { expectedChapters: 3 });
  assert.deepStrictEqual(r.issues, []);
  assert.deepStrictEqual([r.ok, r.numpages], [true, 8]);
  assert.ok(r.charsPerPage >= 80);
});

test('PDF ausente, leve, com poucas paginas e paginas quase vazias e reprovado', async () => {
  assert.deepStrictEqual(await qa.validatePDF(path.join(DIR, 'sumiu.pdf')), { ok: false, issues: ['PDF não encontrado no disco'] });
  const p = await gerarPdf('fraco.pdf', 4, { texto: 'x' });
  const r = await qa.validatePDF(p, { expectedChapters: 5 });
  assert.strictEqual(r.ok, false);
  assert.match(r.issues[0], /PDF muito pequeno: \d+KB \(esperado ≥ 200KB para 5 capítulos\)/);
  assert.ok(r.issues.includes('PDF com apenas 4 páginas (esperado ≥ 9)'), JSON.stringify(r.issues));
  assert.ok(r.issues.some(i => /Texto muito escasso/.test(i)));
  assert.match((await qa.validatePDF(p)).issues[0], /esperado ≥ 100KB para 0 capítulos/, 'sem opcoes o piso e 100 KB');
});

test('arquivo que nao e PDF: magic bytes e parse falham, sobra a verificacao basica', async () => {
  const falso = path.join(DIR, 'falso.pdf');
  fs.writeFileSync(falso, Buffer.alloc(200 * 1024, 66));
  const r = await qa.validatePDF(falso);
  assert.deepStrictEqual(r.issues, ['Arquivo não é um PDF válido (magic bytes inválidos)']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.numpages, undefined, 'parse falhou: sem contagem de paginas');
});

test('pdf-parse indisponivel com arquivo basico bom: aprova pela verificacao basica', async t => {
  interceptar(t, { 'pdf-parse': { default: async () => { throw new Error('modulo quebrado'); } } });
  const bom = path.join(DIR, 'basico.pdf');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(150 * 1024, 32)]));
  const r = await qa.validatePDF(bom);
  assert.deepStrictEqual([r.ok, r.issues], [true, []]);
});

test('PDF que e diretorio: erro de leitura vira problema, sem lancar', async () => {
  const d = path.join(DIR, 'pasta.pdf');
  fs.mkdirSync(d);
  t_statSeguro(d);
  const r = await qa.validatePDF(d);
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(i => /Não foi possível ler o PDF/.test(i)));
});

function t_statSeguro(p) { assert.ok(fs.statSync(p).isDirectory()); }
