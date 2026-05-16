require('dotenv').config();
const { generateFullEbook } = require('./src/agents/writerAgent');
const { generateCover }     = require('./src/agents/coverAgent');
const { generatePDF }       = require('./src/agents/pdfAgent');

async function test() {
  console.log('🚀 Gerando e-book com fixes A4...');
  const ebook = await generateFullEbook('Produtividade e foco no trabalho remoto');
  console.log('✅ Conteúdo:', ebook.title);

  const cover = await generateCover(ebook.title, ebook.subtitle, 'produtividade');
  console.log('✅ Capa:', cover);

  const pdfPath = await generatePDF({ ...ebook, coverPath: cover }, cover);
  console.log('DONE:' + pdfPath);
}

test().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
