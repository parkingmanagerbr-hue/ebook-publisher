// Trava de seguranca da entrega do audiobook no Hotmart.
//
// O risco real nao e "o bonus nao subiu" — e o mp3 cair no campo do manuscrito e
// SUBSTITUIR o e-book pelo audio (foi o que corrompeu manuscritos no KDP). Por isso
// cada caso de recusa aqui vale mais que os casos de aceite.
const assert = require('assert');
const { aceitaAudiobook } = require('../src/agents/publisherHotmart');

const casos = [
  // [descricao, entrada, esperado]
  ['campo livre e vazio', { accept: '', preenchido: false }, true],
  ['campo de audio', { accept: 'audio/*', preenchido: false }, true],
  ['campo de mp3', { accept: '.mp3', preenchido: false }, true],
  ['campo misto pdf+audio', { accept: '.pdf,.mp3', preenchido: false }, true],
  ['accept em maiuscula', { accept: 'AUDIO/MPEG', preenchido: false }, true],

  ['campo do PDF (manuscrito)', { accept: 'application/pdf', preenchido: false }, false],
  ['campo da capa', { accept: 'image/*', preenchido: false }, false],
  ['campo ja preenchido (pdf enviado)', { accept: '', preenchido: true }, false],
  ['campo de audio ja preenchido', { accept: 'audio/*', preenchido: true }, false],
  ['campo de video', { accept: 'video/mp4', preenchido: false }, false],
  ['campo de epub', { accept: '.epub', preenchido: false }, false],
  ['info ausente', null, false],
  ['accept indefinido', { preenchido: false }, true],
];

let falhas = 0;
for (const [desc, entrada, esperado] of casos) {
  const obtido = aceitaAudiobook(entrada);
  if (obtido !== esperado) {
    console.error(`FALHOU: ${desc} — esperado ${esperado}, obtido ${obtido}`);
    falhas++;
  } else {
    console.log(`ok: ${desc} -> ${obtido}`);
  }
}

assert.strictEqual(falhas, 0, `${falhas} caso(s) falharam`);
console.log(`\n${casos.length}/${casos.length} passaram`);
