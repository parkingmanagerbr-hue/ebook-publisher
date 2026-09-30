'use strict';
/**
 * O combo "livro + plano de acao": nome, descricao sem promessa, e o PDF com a
 * pagina de acesso (link clicavel) logo depois da folha de rosto.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { paraWinAnsi, tituloDoCombo, descricaoDoCombo, textoDaPaginaDeAcesso, montarPdfDoCombo, PRECO_COMBO, SUFIXO } =
  require('../src/ferramentas/combo');

async function pdfDeTeste(paginas = 3) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < paginas; i++) doc.addPage([420, 595]).drawText('Pagina original ' + (i + 1), { x: 40, y: 500, size: 14, font: f });
  return doc.save();
}

test('o nome do combo leva o sufixo e respeita o limite', () => {
  assert.strictEqual(tituloDoCombo('Fundo de Emergência em 12 Meses'), 'Fundo de Emergência em 12 Meses + Plano de Ação');
  const longo = tituloDoCombo('T'.repeat(200) + ': subtítulo', 120);
  assert.strictEqual(longo.length, 120);
  assert.ok(longo.endsWith(SUFIXO), 'o sufixo nunca é cortado');
  assert.strictEqual(tituloDoCombo('Guia: ' + 'x'.repeat(200), 30).includes(':' + SUFIXO), false, 'pontuação solta no corte sai');
  assert.strictEqual(tituloDoCombo(''), '', 'sem título não há combo');
  assert.strictEqual(tituloDoCombo(null), '');
});

test('a descrição soma o livro e a ferramenta, sem promessa de resultado', () => {
  const d = descricaoDoCombo('Guia prático para montar a reserva.', 23);
  assert.match(d, /^Guia prático para montar a reserva\.\n\nInclui o Plano de Ação interativo do livro, com 23 passos/);
  assert.ok(!/garant|resultado|fature|lucre/i.test(d), 'nada de promessa');
  assert.match(descricaoDoCombo('', 0), /^Inclui o Plano de Ação interativo do livro organizados/, 'sem descrição, só a ferramenta');
  assert.ok(!/com 0 passos/.test(descricaoDoCombo(null, 'abc')));
  assert.strictEqual(PRECO_COMBO, 19.9, 'preço decidido pelo dono');
});

test('texto que a fonte do PDF não codifica é trocado, acento fica', () => {
  assert.strictEqual(paraWinAnsi('Micro‑Hábitos'), 'Micro-Hábitos');
  assert.strictEqual(paraWinAnsi('“foco” ‘x’'), '"foco" \'x\'');
  assert.strictEqual(paraWinAnsi('ação…'), 'ação...');
  assert.strictEqual(paraWinAnsi('a b'), 'a b');
  assert.strictEqual(paraWinAnsi('ok 🚀'), 'ok ', 'emoji sai');
  assert.strictEqual(paraWinAnsi(null), '');
});

test('a página de acesso nomeia o livro e traz o link', () => {
  const t = textoDaPaginaDeAcesso('Micro‑Hábitos', 'https://veloxisit.com.br/ferramentas/abc/');
  assert.strictEqual(t.link, 'https://veloxisit.com.br/ferramentas/abc/');
  assert.match(t.rodape, /Micro-Hábitos/);
  assert.strictEqual(textoDaPaginaDeAcesso(null, null).link, '');
});

test('o PDF do combo tem a página de acesso logo depois da folha de rosto, com link CLICÁVEL', async () => {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const url = 'https://veloxisit.com.br/ferramentas/e0a28cdcf6b57b39f3054001/';
  const bytes = await montarPdfDoCombo(await pdfDeTeste(3), { titulo: 'Micro‑Hábitos “foco”', url });
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 4, 'uma página a mais');
  const anots = doc.getPage(1).node.lookup(PDFName.of('Annots'));
  assert.ok(anots && anots.size() === 1, 'a página 2 tem a anotação de link');
  const a = anots.lookup(0);
  const acao = a.lookup(PDFName.of('A'));
  assert.strictEqual(acao.lookup(PDFName.of('URI')).decodeText(), url, 'o link aponta para a ferramenta');
  const rosto = doc.getPage(0).node.lookup(PDFName.of('Annots'));
  assert.strictEqual(rosto ? rosto.size() : 0, 0, 'a folha de rosto continua sem link (lista vazia conta como zero)');

  const { lerPdf } = require('../src/agents/qualityAgent');
  const texto = (await lerPdf(Buffer.from(bytes))).text;
  assert.match(texto, /Seu Plano de Ação/);
  assert.match(texto, /Pagina original 1[\s\S]*Seu Plano de Ação[\s\S]*Pagina original 2/, 'ordem: rosto, acesso, resto');
});

test('link comprido demais para a linha usa letra menor, mas continua inteiro', async () => {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const url = 'https://veloxisit.com.br/ferramentas/' + 'a'.repeat(60) + '/';
  const doc = await PDFDocument.load(await montarPdfDoCombo(await pdfDeTeste(1), { titulo: 'X', url }));
  assert.strictEqual(doc.getPageCount(), 2, 'livro de uma página: acesso vai em segundo');
  const acao = doc.getPage(1).node.lookup(PDFName.of('Annots')).lookup(0).lookup(PDFName.of('A'));
  assert.strictEqual(acao.lookup(PDFName.of('URI')).decodeText(), url);
});

test('sem link https não se monta combo (livro vendido sem a ferramenta)', async () => {
  const pdf = await pdfDeTeste(1);
  await assert.rejects(montarPdfDoCombo(pdf, { titulo: 'X', url: '' }), /COMBO_SEM_LINK/);
  await assert.rejects(montarPdfDoCombo(pdf, { titulo: 'X', url: 'http://inseguro/' }), /COMBO_SEM_LINK/);
});

test('em página larga (A4) o link cabe na letra normal', async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const base = await PDFDocument.create();
  const f = await base.embedFont(StandardFonts.Helvetica);
  base.addPage([595, 842]).drawText('Rosto', { x: 40, y: 700, size: 14, font: f });
  const url = 'https://veloxisit.com.br/ferramentas/e0a28cdcf6b57b39f3054001/';
  const doc = await PDFDocument.load(await montarPdfDoCombo(await base.save(), { titulo: 'Livro', url }));
  assert.strictEqual(doc.getPageCount(), 2);
  const { width } = doc.getPage(1).getSize();
  assert.strictEqual(width, 595, 'a página de acesso tem o tamanho do livro');
});
