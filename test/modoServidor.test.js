'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { noServidor, urlCdpDoServidor } = require('../src/core/modoServidor');

test('so liga com PUBLICAR_NO_SERVIDOR=1', () => {
  assert.strictEqual(noServidor({ PUBLICAR_NO_SERVIDOR: '1' }), true);
  assert.strictEqual(noServidor({}), false);
  assert.strictEqual(noServidor({ PUBLICAR_NO_SERVIDOR: '0' }), false);
});

test('nome do container vira IP (o Chrome recusa Host que nao e IP)', async () => {
  const url = await urlCdpDoServidor({}, async (h) => { assert.strictEqual(h, 'navegador-hotmart'); return { address: '172.18.0.42' }; });
  assert.strictEqual(url, 'http://172.18.0.42:9223');
});

test('IP informado nao passa pelo DNS; porta configuravel', async () => {
  const url = await urlCdpDoServidor({ HOTMART_CDP_HOST: '10.0.0.5', HOTMART_CDP_PORTA: '9999' }, async () => { throw new Error('nao devia resolver'); });
  assert.strictEqual(url, 'http://10.0.0.5:9999');
});

test('resolucao que nao devolve IP e recusada com o motivo de ambiente', async () => {
  await assert.rejects(urlCdpDoServidor({}, async () => ({ address: 'lixo' })), /CHROME_FORA_DO_AR/);
});

test('rodarAqui executa o trecho na pasta dada, devolve a saida e apaga o arquivo', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { rodarAqui } = require('../src/core/modoServidor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqui-'));
  const saida = rodarAqui("console.log(JSON.stringify([process.cwd() === " + JSON.stringify(fs.realpathSync(dir)) + ", 2+2]))", { dir });
  assert.strictEqual(saida.trim(), '[true,4]');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.throws(() => rodarAqui('process.exit(3)', { dir }));
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'falha tambem apaga o arquivo');
});

test('pasta de trabalho: na VPS e a pasta compartilhada com o Chrome; fora, a temporaria', () => {
  const path = require('path'); const os = require('os');
  const { pastaDeTrabalho } = require('../src/core/modoServidor');
  assert.strictEqual(pastaDeTrabalho('kdp', { PUBLICAR_NO_SERVIDOR: '1' }), path.join('/app/data/navegador_tmp', 'kdp'));
  assert.strictEqual(pastaDeTrabalho('kdp', {}), path.join(os.tmpdir(), 'kdp'));
  if (process.env.PUBLICAR_NO_SERVIDOR !== '1') assert.strictEqual(pastaDeTrabalho('kdp'), path.join(os.tmpdir(), 'kdp'), 'sem ambiente: o do processo');
});

test('pasta temporaria nasce legivel por outro usuario (o Chrome e outro container)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { pastaTemporaria } = require('../src/core/modoServidor');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  const velho = process.umask(0o077); // umask fechado: so a correcao explicita abre
  try {
    const dir = pastaTemporaria('pdfs-hm', { PUBLICAR_NO_SERVIDOR: '1', PUBLICAR_TMP: base });
    assert.ok(dir.startsWith(path.join(base, 'pdfs-hm') + path.sep));
    // Windows nao tem modo de arquivo; a prova do 755 roda no container (Linux).
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755);
    assert.notStrictEqual(pastaTemporaria('pdfs-hm', { PUBLICAR_NO_SERVIDOR: '1', PUBLICAR_TMP: base }), dir, 'cada chamada, pasta nova');
    // Sem ambiente explicito (como o script chama): le o do processo.
    const antes = { n: process.env.PUBLICAR_NO_SERVIDOR, t: process.env.PUBLICAR_TMP };
    process.env.PUBLICAR_NO_SERVIDOR = '1'; process.env.PUBLICAR_TMP = base;
    try { assert.ok(pastaTemporaria('pdfs-hm').startsWith(path.join(base, 'pdfs-hm'))); }
    finally {
      if (antes.n === undefined) delete process.env.PUBLICAR_NO_SERVIDOR; else process.env.PUBLICAR_NO_SERVIDOR = antes.n;
      if (antes.t === undefined) delete process.env.PUBLICAR_TMP; else process.env.PUBLICAR_TMP = antes.t;
    }
  } finally { process.umask(velho); fs.rmSync(base, { recursive: true, force: true }); }
});

test('sem resolvedor injetado, o nome passa pelo DNS de verdade; sem ambiente, le o do processo', async () => {
  const { urlCdpDoServidor } = require('../src/core/modoServidor');
  assert.strictEqual(await urlCdpDoServidor({ HOTMART_CDP_HOST: 'localhost', HOTMART_CDP_PORTA: '9301' }), 'http://127.0.0.1:9301');
  const antes = process.env.HOTMART_CDP_HOST;
  process.env.HOTMART_CDP_HOST = '10.9.8.7';
  try { assert.strictEqual(await urlCdpDoServidor(), 'http://10.9.8.7:' + Number(process.env.HOTMART_CDP_PORTA || 9223)); }
  finally { if (antes === undefined) delete process.env.HOTMART_CDP_HOST; else process.env.HOTMART_CDP_HOST = antes; }
});

test('rodarAqui: arquivo que ja sumiu na limpeza nao derruba a saida', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { rodarAqui } = require('../src/core/modoServidor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqui-'));
  assert.strictEqual(rodarAqui("require('fs').unlinkSync(__filename); console.log('ok')", { dir }).trim(), 'ok');
});
