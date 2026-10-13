'use strict';
/**
 * Link do audiolivro. Ate 13/10/2026 o MP3 de livro a venda saia publico em
 * /audiobooks/<id>.mp3 (206 audio/mpeg sem credencial), e o token do PDF leva o
 * mesmo id: a assinatura do audio precisa de finalidade propria, senao quem
 * comprou o e-book de R$ 4,99 leva o audiolivro trocando o caminho do link.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { gerarToken, verificarToken, urlEntrega, urlAudio, nomeArquivo, criarRotaAudio, soAudioPublico } = require('../src/core/entrega');

const ENV = { ENTREGA_SECRET: 'segredo-de-teste' };
const ID = '0c104665-ee04-4964-aab3-e781471f1247';

test('token do PDF nao abre o audio, e o do audio nao abre o PDF', () => {
  const doPdf = gerarToken(ID, ENV);
  const doAudio = gerarToken(ID, ENV, 'audio');
  assert.notStrictEqual(doPdf, doAudio, 'assinaturas diferentes para o mesmo livro');
  assert.strictEqual(verificarToken(doAudio, ENV, 'audio'), ID);
  assert.strictEqual(verificarToken(doPdf, ENV, 'audio'), null, 'comprador do e-book nao chega no MP3');
  assert.strictEqual(verificarToken(doAudio, ENV), null, 'e o inverso tambem');
  assert.throws(() => gerarToken(ID, ENV, 'outra'), /finalidade/);
});

test('url do audio usa a base publica e o token de audio', () => {
  const u = urlAudio(ID, ENV);
  assert.ok(u.startsWith('https://publisher.veloxisit.com.br/audio/' + ID + '.'));
  assert.strictEqual(verificarToken(u.split('/audio/')[1], ENV, 'audio'), ID);
  assert.ok(urlAudio(ID, { ...ENV, PUBLIC_BASE_URL: 'https://x.test//' }).startsWith('https://x.test/audio/'));
  assert.notStrictEqual(urlAudio(ID, ENV).split('/').pop(), urlEntrega(ID, ENV).split('/').pop());
  assert.strictEqual(nomeArquivo('Guia: "Foco"', '.mp3'), 'Guia Foco.mp3');
});

function resFalso() {
  const r = { headers: {}, status(c) { r.code = c; return r; }, send(b) { r.body = b; return r; },
    set(k, v) { r.headers[k] = v; return r; }, sendFile(p) { r.code = 200; r.arquivo = p; return r; } };
  return r;
}
function logFalso() {
  const linhas = [];
  return { linhas, info: m => linhas.push('info ' + m), warn: m => linhas.push('warn ' + m), error: m => linhas.push('error ' + m) };
}

test('rota do audio: 404 mudo com token errado, 404 + log sem arquivo, 503 sem segredo', () => {
  const fsFalso = existe => ({ existsSync: () => existe });
  let log = logFalso(); let res = resFalso();
  criarRotaAudio({ dir: '/d', fs: fsFalso(true), env: ENV, log })({ params: { token: gerarToken(ID, ENV) } }, res);
  assert.strictEqual(res.code, 404, 'token do PDF na rota do audio');
  assert.strictEqual(res.body, 'Nao encontrado.', 'nao diz por que');
  assert.match(log.linhas[0], /^warn \[audio\] token recusado/);

  log = logFalso(); res = resFalso();
  const token = gerarToken(ID, ENV, 'audio');
  criarRotaAudio({ dir: '/d', fs: fsFalso(false), env: ENV, log })({ params: { token } }, res);
  assert.strictEqual(res.code, 404);
  assert.match(log.linhas[0], /^error \[audio\] MP3 ausente para livro 0c104665/);
  assert.ok(!log.linhas.join(' ').includes(token.split('.')[1]), 'a assinatura nunca vai para o log');

  res = resFalso();
  criarRotaAudio({ dir: '/d', fs: fsFalso(true), env: {}, log: null })({ params: { token: 'a.b' } }, res);
  assert.strictEqual(res.code, 503);

  log = logFalso(); res = resFalso();
  criarRotaAudio({ dir: '/d', fs: fsFalso(true), env: ENV, log, buscarTitulo: () => { throw new Error('banco fora'); } })(
    { params: { token }, headers: {} }, res);
  assert.strictEqual(res.code, 200, 'banco fora nao impede o download');
  assert.match(res.headers['Content-Disposition'], /audiolivro\.mp3/);
  assert.strictEqual(res.arquivo, path.resolve('/d', ID + '.mp3'));

  // Log que estoura nao derruba o download.
  res = resFalso();
  const quebrado = { info() { throw new Error('x'); }, warn() { throw new Error('x'); }, error() { throw new Error('x'); } };
  criarRotaAudio({ dir: '/d', fs: fsFalso(true), env: ENV, log: quebrado })({ params: { token }, headers: {} }, res);
  assert.strictEqual(res.code, 200);
});

test('estatico /audiobooks: so gutenberg-*.mp3 passa', () => {
  const passa = p => { let ok = false; const res = resFalso(); soAudioPublico({ path: p }, res, () => { ok = true; }); return ok ? 'next' : res.code; };
  assert.strictEqual(passa('/gutenberg-1342.mp3'), 'next');
  assert.strictEqual(passa('/gutenberg-pt_dom-casmurro.mp3'), 'next');
  assert.strictEqual(passa('/' + ID + '.mp3'), 404, 'o MP3 do livro a venda fica fechado');
  assert.strictEqual(passa('/gutenberg-1342.mp3.bak'), 404);
  assert.strictEqual(passa('/gutenberg-..%2F' + ID + '.mp3'), 404, 'caminho codificado nao escapa');
  assert.strictEqual(passa('/x/gutenberg-1.mp3'), 404);
  assert.strictEqual(passa('/'), 404, 'nem listagem');
});

test('servidor de verdade: Range funciona no link assinado e o estatico recusa o MP3 do livro', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
  const corpo = Buffer.alloc(5000, 7);
  fs.writeFileSync(path.join(dir, ID + '.mp3'), corpo);
  fs.writeFileSync(path.join(dir, 'gutenberg-11.mp3'), Buffer.alloc(300, 1));
  const app = express();
  app.use('/audiobooks', soAudioPublico, express.static(dir));
  app.get('/audio/:token', criarRotaAudio({ dir, env: ENV, buscarTitulo: () => 'Liderança Prática' }));
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const token = gerarToken(ID, ENV, 'audio');
    let r = await fetch(base + '/audio/' + token, { headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(r.status, 206, 'trecho: o player do celular pede assim');
    assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual((await r.arrayBuffer()).byteLength, 100);
    assert.match(r.headers.get('content-disposition'), /Lideran%C3%A7a%20Pr%C3%A1tica\.mp3/);
    assert.match(r.headers.get('cache-control'), /private/);
    assert.match(r.headers.get('x-robots-tag'), /noindex/);

    r = await fetch(base + '/audio/' + token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.arrayBuffer()).byteLength, 5000);

    const adulterado = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    r = await fetch(base + '/audio/' + adulterado); await r.arrayBuffer();
    assert.strictEqual(r.status, 404);

    r = await fetch(base + '/audiobooks/' + ID + '.mp3'); await r.arrayBuffer();
    assert.strictEqual(r.status, 404, 'o caminho que vazava');
    r = await fetch(base + '/audiobooks/gutenberg-11.mp3');
    assert.strictEqual(r.status, 200, 'dominio publico continua aberto');
    assert.strictEqual((await r.arrayBuffer()).byteLength, 300);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
