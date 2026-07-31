'use strict';
// Testa o gate de publish do KDP com conteúdo RECÉM-GERADO, pelo Chrome local 9223
// (o único que passa os 3 níveis de step-up). Declaração de IA permanece verdadeira.
process.env.KDP_BROWSER_URL = 'http://localhost:9223';
process.env.KDP_PRICE_USD   = '2.99';
process.env.KDP_AUTHOR_NAME = 'GENIA Editorial';

const fs = require('fs');
const path = require('path');
const { publishToAmazon } = require('./src/agents/publisherAmazon');

const dir = path.resolve('data/kdp_novo');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'n.json'), 'utf8'));

const ebook = {
  title: meta.title,
  subtitle: meta.subtitle || '',
  description: (meta.description || '').trim(),
  topic: meta.topic || meta.title,
  keywords: 'psicologia das vendas, persuasão, influência, vendas, negociação, marketing, gatilhos mentais',
  language: 'pt',
  pdfPath: path.join(dir, 'n.pdf'),
  coverPath: path.join(dir, 'n.png'),
  price: 2.99,
  kdpSelect: false,   // sem exclusividade — Cakto/Hotmart vendem o mesmo título
};

console.log('>>> KDP (9223) conteúdo novo:', ebook.title);
console.log('    pdf:', fs.existsSync(ebook.pdfPath), '| capa:', fs.existsSync(ebook.coverPath));

publishToAmazon(ebook)
  .then(r => console.log('FINAL_RESULT ' + JSON.stringify(r)))
  .catch(e => console.log('FINAL_ERR ' + (e && e.message)));
