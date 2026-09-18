'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { idiomaDoTitulo } = require('../scripts/capasExternasHotmart');

test('idioma pelo titulo: acento manda, depois palavra em ingles', () => {
  assert.strictEqual(idiomaDoTitulo('A Bíblia e as Finanças'), 'pt-BR');
  assert.strictEqual(idiomaDoTitulo('AI Money Mastery 2026'), 'en-US');
  assert.strictEqual(idiomaDoTitulo('The Complete Guide'), 'en-US');
  assert.strictEqual(idiomaDoTitulo('Adestramento Facil'), 'pt-BR');
  assert.strictEqual(idiomaDoTitulo(null), 'pt-BR');
});
