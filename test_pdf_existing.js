/**
 * Testa geração de PDF com o e-book de exemplo existente (sem precisar de AI de texto)
 * Verifica os fixes de A4 + layout
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { generateCover } = require('./src/agents/coverAgent');
const { generatePDF }   = require('./src/agents/pdfAgent');

async function test() {
  // Carregar ebook de exemplo já salvo
  const ebookData = JSON.parse(fs.readFileSync('./data/example_ebook.json', 'utf-8'));
  ebookData.wordCount = ebookData.wordCount || 5800;

  console.log(`📚 E-book: "${ebookData.title}"`);
  console.log(`   ${ebookData.chapters.length} capítulos, ${ebookData.wordCount} palavras`);

  // Gerar capa
  console.log('\n🎨 Gerando capa...');
  const coverPath = await generateCover(ebookData.title, ebookData.subtitle, ebookData.topic);
  console.log(`✅ Capa: ${coverPath}`);

  // Gerar PDF com fixes A4
  console.log('\n📄 Gerando PDF (A4 fix)...');
  const pdfPath = await generatePDF({ ...ebookData, coverPath }, coverPath);
  console.log(`DONE:${pdfPath}`);
}

test().catch(e => {
  console.error('ERRO:', e.message);
  console.error(e.stack);
  process.exit(1);
});
