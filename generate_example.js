/**
 * Gerador de exemplo — usa e-book pré-gerado para demonstrar capa + PDF
 */
require('dotenv').config();
const { generateCover } = require('./src/agents/coverAgent');
const { generatePDF } = require('./src/agents/pdfAgent');
const { createLogger } = require('./src/core/logger');
const logger = createLogger('example');

async function main() {
  logger.info('🎯 Gerando capa e PDF do e-book de exemplo...');

  const ebook = require('./data/example_ebook.json');

  logger.info(`📚 E-book: "${ebook.title}"`);
  logger.info(`📝 Palavras: ${ebook.wordCount}`);

  // Gerar capa
  logger.info('\n🎨 Gerando capa...');
  const coverPath = await generateCover(ebook.title, ebook.subtitle, ebook.topic);
  logger.info(`✅ Capa: ${coverPath}`);

  // Gerar PDF
  logger.info('\n📄 Gerando PDF...');
  const pdfPath = await generatePDF({ ...ebook, coverPath }, coverPath);
  logger.info(`✅ PDF: ${pdfPath}`);

  logger.info('\n' + '='.repeat(60));
  logger.info('✅ E-BOOK DE EXEMPLO GERADO!');
  logger.info(`   Título: ${ebook.title}`);
  logger.info(`   Capítulos: ${ebook.chapters.length}`);
  logger.info(`   Palavras: ~${ebook.wordCount}`);
  logger.info(`   Preço: R$ 4,99`);
  logger.info(`   Capa: ${coverPath}`);
  logger.info(`   PDF: ${pdfPath}`);
  logger.info('='.repeat(60));
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
