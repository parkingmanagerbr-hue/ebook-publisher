'use strict';
/**
 * Capa em JPEG dentro do PDF: o PNG sem perda custava ~3,3 MB por livro e
 * enchia o disco da VPS (91% em 14/10/2026). Gerador e recompressao dos PDFs
 * ja vendidos — onde qualquer duvida mantem o original.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const PDFKit = require('pdfkit');
const J = require('../src/agents/capaJpeg');

/** PNG RGB de "foto": degrade suave com ruido — o tipo de imagem das capas. */
function pngFoto(w = 800, h = 1280) {
  const linhas = [];
  let s = 7;
  for (let y = 0; y < h; y++) {
    const l = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const r = s % 24;
      l[1 + x * 3] = (x * 255 / w + r) & 255; l[2 + x * 3] = (y * 255 / h + r) & 255; l[3 + x * 3] = (128 + r) & 255;
    }
    linhas.push(l);
  }
  return J.pngDoFlate({ dados: zlib.deflateSync(Buffer.concat(linhas)), largura: w, altura: h });
}

function pastaTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'capajpeg-')); }

function pdfComCapa(arquivo, capa, paginas = ['Capitulo um: o texto do livro.', 'Capitulo dois.']) {
  return new Promise(ok => {
    const d = new PDFKit({ size: [432, 648] });
    const s = fs.createWriteStream(arquivo);
    d.pipe(s);
    d.image(capa, 0, 0, { width: 432, height: 648 });
    for (const p of paginas) d.addPage().text(p);
    d.end();
    s.on('finish', ok);
  });
}

test('PNG vira JPEG, no maximo 1600 de largura, com o tamanho medido', async () => {
  const png = pngFoto(2000, 3200);
  const j = await J.paraJpeg(png);
  assert.deepStrictEqual([j.bytes[0], j.bytes[1]], [0xff, 0xd8], 'e JPEG');
  assert.deepStrictEqual([j.largura, j.altura], [1600, 2560], 'reduz mantendo a proporcao');
  const igual = await J.paraJpeg(pngFoto(400, 640));
  assert.deepStrictEqual([igual.largura, igual.altura], [400, 640], 'imagem menor nao aumenta');
  assert.strictEqual(J.QUALIDADE, 85);
});

test('gerador: PDF com capa PNG de 1600x2560 fica pequeno quando a capa vai em JPEG', async () => {
  const dir = pastaTemp();
  const png = path.join(dir, 'capa.png');
  fs.writeFileSync(png, pngFoto(1600, 2560));
  const avisos = [];
  const capa = await J.capaParaPdf(png, { destino: path.join(dir, 'capa.tmp.jpg'), avisar: m => avisos.push(m) });
  assert.strictEqual(capa.temporario, true);
  assert.ok(capa.kbDepois < capa.kbAntes, capa.kbAntes + ' -> ' + capa.kbDepois);
  await pdfComCapa(path.join(dir, 'png.pdf'), png);
  await pdfComCapa(path.join(dir, 'jpg.pdf'), capa.caminho);
  const kbPng = fs.statSync(path.join(dir, 'png.pdf')).size / 1024;
  const kbJpg = fs.statSync(path.join(dir, 'jpg.pdf')).size / 1024;
  assert.ok(kbJpg < 1500, 'PDF com a capa em JPEG: ' + Math.round(kbJpg) + ' KB');
  assert.ok(kbJpg < kbPng / 3, 'menos de um terco do PDF com PNG (' + Math.round(kbPng) + ' KB)');
  assert.deepStrictEqual(avisos, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capa ja em JPEG vai como esta; capa ilegivel vai a original, com aviso', async () => {
  const dir = pastaTemp();
  const jpg = path.join(dir, 'c.jpg');
  fs.writeFileSync(jpg, (await J.paraJpeg(pngFoto(100, 160))).bytes);
  assert.deepStrictEqual(await J.capaParaPdf(jpg), { caminho: jpg, temporario: false });
  const ruim = path.join(dir, 'ruim.png');
  fs.writeFileSync(ruim, Buffer.from('nao e imagem'));
  const avisos = [];
  assert.deepStrictEqual(await J.capaParaPdf(ruim, { avisar: m => avisos.push(m) }), { caminho: ruim, temporario: false });
  assert.match(avisos[0], /capa nao convertida para JPEG/);
  const semDestino = await J.capaParaPdf(path.join(dir, '..', path.basename(dir), 'c.jpg').replace('c.jpg', 'x.png'), { ler: () => pngFoto(50, 80) });
  assert.ok(semDestino.temporario && fs.existsSync(semDestino.caminho), 'sem destino, vai para o temporario do sistema');
  fs.unlinkSync(semDestino.caminho);
  assert.deepStrictEqual(await J.capaParaPdf('x', { ler: () => Buffer.from('ruim') }), { caminho: 'x', temporario: false }, 'sem avisar injetado nao quebra');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PNG remontado do stream Flate abre como imagem; tons de cinza tambem; 4 canais nao', async () => {
  const { loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(pngFoto(30, 20));
  assert.deepStrictEqual([img.width, img.height], [30, 20]);
  const cinza = J.pngDoFlate({ dados: zlib.deflateSync(Buffer.alloc(11 * 5)), largura: 10, altura: 5, cores: 1 });
  assert.strictEqual((await loadImage(cinza)).width, 10);
  assert.throws(() => J.pngDoFlate({ dados: Buffer.alloc(1), largura: 1, altura: 1, cores: 4 }), /cores nao suportadas/);
});

test('o que pode ser trocado: so Flate com preditor PNG, 8 bits, sem alfa, grande', () => {
  const boa = { filtro: '/FlateDecode', preditor: 15, cores: 3, bits: 8, temAlfa: false, bytes: 3e6 };
  assert.strictEqual(J.motivoParaNaoTrocar(boa), null);
  assert.strictEqual(J.motivoParaNaoTrocar(null), 'sem-imagem-na-pagina-1');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, filtro: '/DCTDecode' }), 'ja-jpeg');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, filtro: '/JPXDecode' }), 'filtro-JPXDecode');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, preditor: null }), 'sem-preditor-png');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, bits: 16 }), 'formato-nao-suportado');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, cores: 4 }), 'formato-nao-suportado');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, cores: 1 }), null);
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, temAlfa: true }), 'com-alfa', 'tirar a mascara muda a capa');
  assert.strictEqual(J.motivoParaNaoTrocar({ ...boa, bytes: 200 * 1024 }), 'pequena');
});

test('o novo so toma o lugar com as mesmas paginas, o mesmo texto e mais de 30% de ganho', () => {
  const ok = { antes: 1000, depois: 699, paginasAntes: 30, paginasDepois: 30, textoAntes: 'abc', textoDepois: 'abc' };
  assert.strictEqual(J.motivoParaRecusar(ok), null);
  assert.strictEqual(J.motivoParaRecusar({ ...ok, depois: 701 }), 'ganho-pequeno');
  assert.strictEqual(J.motivoParaRecusar({ ...ok, depois: 700 }), null, '30% exatos passam');
  assert.strictEqual(J.motivoParaRecusar({ ...ok, paginasDepois: 29 }), 'paginas-diferentes');
  assert.strictEqual(J.motivoParaRecusar({ ...ok, textoDepois: 'abd' }), 'texto-diferente');
  assert.strictEqual(J.motivoParaRecusar({ ...ok, depois: 0 }), 'arquivo-vazio');
});

test('script: troca so a capa do PDF do PDFKit, com o texto e as paginas iguais', async () => {
  const { recomprimir, imagemDaPagina1 } = require('../scripts/recomprimirCapaPdf');
  const { PDFDocument } = require('pdf-lib');
  const { lerPdf } = require('../src/agents/qualityAgent');
  const dir = pastaTemp();
  const png = path.join(dir, 'capa.png');
  fs.writeFileSync(png, pngFoto(1600, 2560));
  const pdf = path.join(dir, 'livro.pdf');
  await pdfComCapa(pdf, png, ['Capitulo um: aprenda a planejar.', 'Capitulo dois: a rota.', 'Capitulo tres.']);
  const original = fs.readFileSync(pdf);
  const seco = await recomprimir(pdf, { seco: true });
  assert.strictEqual(seco.resultado, 'seria-substituido');
  assert.ok(fs.readFileSync(pdf).equals(original), 'seco nao toca no arquivo');
  const r = await recomprimir(pdf);
  assert.strictEqual(r.resultado, 'substituido');
  assert.ok(r.depois < r.antes * 0.7, r.antes + ' -> ' + r.depois);
  assert.strictEqual(fs.statSync(pdf).size, r.depois);
  const doc = await PDFDocument.load(fs.readFileSync(pdf));
  assert.strictEqual(doc.getPageCount(), 4);
  const img = imagemDaPagina1(doc);
  assert.deepStrictEqual([img.filtro, img.largura, img.altura], ['/DCTDecode', 1600, 2560], 'mesmas dimensoes, agora em JPEG');
  const t1 = (await lerPdf(original)).text;
  const t2 = (await lerPdf(fs.readFileSync(pdf))).text;
  assert.strictEqual(t2, t1, 'texto identico');
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.tmp')), 'sem temporario sobrando');
  assert.strictEqual((await recomprimir(pdf)).motivo, 'ja-jpeg', 'segunda passada nao mexe');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: capa com alfa e PDF sem imagem ficam como estao', async () => {
  const { recomprimir } = require('../scripts/recomprimirCapaPdf');
  const { createCanvas } = require('@napi-rs/canvas');
  const dir = pastaTemp();
  const c = createCanvas(400, 640);
  c.getContext('2d').fillRect(0, 0, 200, 200);
  const rgba = path.join(dir, 'a.png');
  fs.writeFileSync(rgba, await c.encode('png'));
  await pdfComCapa(path.join(dir, 'alfa.pdf'), rgba);
  assert.strictEqual((await recomprimir(path.join(dir, 'alfa.pdf'))).motivo, 'com-alfa');
  await new Promise(ok => { const d = new PDFKit(); const s = fs.createWriteStream(path.join(dir, 'texto.pdf')); d.pipe(s); d.text('so texto'); d.end(); s.on('finish', ok); });
  assert.strictEqual((await recomprimir(path.join(dir, 'texto.pdf'))).motivo, 'sem-imagem-na-pagina-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script executavel: diario por arquivo, retomavel, e o que falha nao para o lote', async () => {
  const dir = pastaTemp();
  const pdfs = path.join(dir, 'pdfs');
  fs.mkdirSync(pdfs);
  const png = path.join(dir, 'capa.png');
  fs.writeFileSync(png, pngFoto(1600, 2560));
  await pdfComCapa(path.join(pdfs, 'ebook_a.pdf'), png);
  await pdfComCapa(path.join(pdfs, 'combo_b.pdf'), png);
  fs.writeFileSync(path.join(pdfs, 'quebrado.pdf'), 'isto nao e pdf');
  const diario = path.join(dir, 'diario.jsonl');
  const rodar = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'recomprimirCapaPdf.js'), ...a],
    { encoding: 'utf8', env: { ...process.env, PDFS_DIR: pdfs, DIARIO_RECOMPRESSAO: diario } });
  let r = rodar('--limite=2');
  assert.strictEqual(r.status, 0, r.stderr);
  let resumo = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(resumo.substituidos, 2, 'os dois maiores primeiro');
  r = rodar();
  resumo = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepStrictEqual([resumo.fila, resumo.erros, resumo.jaFeitos], [1, 1, 2], 'retoma: so o que faltava; o quebrado vira erro');
  const linhas = fs.readFileSync(diario, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(linhas.map(l => l.resultado).sort(), ['erro', 'substituido', 'substituido']);
  assert.ok(linhas.every(l => l.arquivo && l.quando));
  r = rodar('--seco', '--arquivos=ebook_a.pdf');
  assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).fila, 0, 'o que esta no diario nao volta');
  fs.appendFileSync(diario, 'linha cortada\n');
  assert.strictEqual(require('../scripts/recomprimirCapaPdf').jaFeitos(diario).size, 3, 'linha ilegivel do diario nao derruba');
  assert.strictEqual(require('../scripts/recomprimirCapaPdf').jaFeitos(path.join(dir, 'nao-existe')).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: recusa da conferencia MANTEM o original, byte por byte', async () => {
  const { recomprimir } = require('../scripts/recomprimirCapaPdf');
  const dir = pastaTemp();
  const png = path.join(dir, 'capa.png');
  fs.writeFileSync(png, pngFoto(1600, 2560));
  const pdf = path.join(dir, 'livro.pdf');
  await pdfComCapa(pdf, png);
  const original = fs.readFileSync(pdf);
  let visto = null;
  const r = await recomprimir(pdf, { decidir: d => { visto = d; return 'texto-diferente'; } });
  assert.deepStrictEqual([r.resultado, r.motivo], ['mantido', 'texto-diferente']);
  assert.ok(fs.readFileSync(pdf).equals(original), 'o arquivo vendido nao foi tocado');
  assert.ok(visto && visto.textoAntes.length > 0 && visto.paginasAntes === 3, 'a decisao recebeu o texto e as paginas lidos');
  fs.rmSync(dir, { recursive: true, force: true });
});
