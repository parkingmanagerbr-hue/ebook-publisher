'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isAvailable } = require('../src/agents/audiobookAgent');

test('AUDIOBOOK_ATIVO=false desliga a geracao de audio', () => {
  const antes = process.env.AUDIOBOOK_ATIVO;
  try {
    process.env.AUDIOBOOK_ATIVO = 'FALSE';
    assert.strictEqual(isAvailable(), false);
    delete process.env.AUDIOBOOK_ATIVO;
    assert.strictEqual(typeof isAvailable(), 'boolean');
  } finally {
    if (antes === undefined) delete process.env.AUDIOBOOK_ATIVO; else process.env.AUDIOBOOK_ATIVO = antes;
  }
});
