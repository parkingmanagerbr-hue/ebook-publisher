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
});
