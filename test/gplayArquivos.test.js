'use strict';
/**
 * O PDF que sobe para o Google Play: a pagina 1 dos nossos PDFs e a capa
 * antiga em imagem, com titulo-gancho diferente do cadastro. Sai quando nao
 * tem texto; folha de rosto escrita fica.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { prepararPdf, temFonte } = require('../src/agents/gplayArquivos');

async function pdf({ primeiraComTexto }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const capa = doc.addPage([420, 595]);
  if (primeiraComTexto) capa.drawText('Folha de rosto', { x: 40, y: 500, size: 14, font: f });
  else capa.drawRectangle({ x: 0, y: 0, width: 420, height: 595, color: rgb(0.2, 0.3, 0.5) });
  // Largura diferente por capitulo: prova a ORDEM sem depender de extrator de texto.
  for (let i = 1; i <= 3; i++) doc.addPage([420 + i, 595]).drawText('Capitulo ' + i, { x: 40, y: 500, size: 14, font: f });
  doc.setTitle('TITULO GANCHO DA CAPA ANTIGA');
  return doc.save();
}

test('pagina 1 sem texto (capa em imagem) sai; titulo do metadado vira o do cadastro', async () => {
  const { PDFDocument } = require('pdf-lib');
  const r = await prepararPdf(await pdf({ primeiraComTexto: false }), { titulo: 'Viajar barato e bem pelo Brasil' });
  assert.strictEqual(r.tirouPrimeira, true);
  assert.strictEqual(r.paginas, 3);
  const doc = await PDFDocument.load(r.bytes);
  assert.strictEqual(doc.getPageCount(), 3);
  assert.strictEqual(doc.getTitle(), 'Viajar barato e bem pelo Brasil');
  assert.strictEqual(doc.getAuthor(), 'Veloxis Editorial');
  assert.ok(doc.getPages().every(temFonte), 'sobraram so as paginas escritas');
  assert.deepStrictEqual(doc.getPages().map(p => p.getWidth()), [421, 422, 423], 'o resto do livro fica, na ordem');
});

test('pagina 1 com texto fica', async () => {
  const r = await prepararPdf(await pdf({ primeiraComTexto: true }), { titulo: 'X' });
  assert.strictEqual(r.tirouPrimeira, false);
  assert.strictEqual(r.paginas, 4);
});

test('livro de uma pagina so nunca fica vazio, e sem titulo o metadado antigo fica', async () => {
  const { PDFDocument } = require('pdf-lib');
  const um = await PDFDocument.create();
  um.addPage([420, 595]);
  um.setTitle('Antigo');
  const r = await prepararPdf(await um.save());
  assert.strictEqual(r.paginas, 1);
  assert.strictEqual(r.tirouPrimeira, false);
  assert.strictEqual((await PDFDocument.load(r.bytes)).getTitle(), 'Antigo');
});
