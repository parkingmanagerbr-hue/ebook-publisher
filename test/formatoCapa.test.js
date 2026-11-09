'use strict';
/**
 * Capa nova sai em JPEG. 09/11/2026: o estoque tinha sido convertido em 08/10,
 * mas os geradores seguiram gravando PNG de ~3,3 MB e o disco voltou a 97%.
 * A varredura no fim impede que um gerador volte a gravar PNG sem ninguém ver.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../src/agents/formatoCapa');

test('captura em JPEG com a qualidade do conversor, preservando as outras opções', () => {
  const o = F.opcoesDeCaptura({ path: '/x/c.jpg', clip: { x: 0, y: 0, width: 1600, height: 2560 }, type: 'png' });
  assert.strictEqual(o.type, 'jpeg');
  assert.strictEqual(o.quality, 88);
  assert.strictEqual(o.path, '/x/c.jpg');
  assert.strictEqual(o.clip.height, 2560);
  assert.strictEqual(F.opcoesDeCaptura().type, 'jpeg');
});

test('nome da capa nova termina em .jpg', () => {
  assert.strictEqual(F.caminhoDeCapa(path.join('a', 'covers'), 'cover_html', 1794229838974),
    path.join('a', 'covers', 'cover_html_1794229838974.jpg'));
  assert.match(path.basename(F.caminhoDeCapa('covers', 'cover')), /^cover_\d+\.jpg$/);
});

// Geradores que ainda gravam PNG e por quê. Entrar aqui exige motivo escrito.
const AINDA_PNG = {
  'coverAgent.js': 'caminho Gemini/Canvas: 0 capas em 48 h de log (09/11/2026)',
  'claudeDesignAgent.js': 'sem chave da Anthropic no produto; não gera capa em produção',
};

test('nenhum gerador de capa em uso volta a gravar PNG', () => {
  const pasta = path.join(__dirname, '..', 'src', 'agents');
  const achados = [];
  let olhados = 0;
  for (const f of fs.readdirSync(pasta).filter((n) => n.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(pasta, f), 'utf8');
    const grava = /cover[a-z_]*_\$\{Date\.now\(\)\}\.png|type:\s*'png'/.test(txt) && /cover/i.test(f);
    if (/cover|capa|design/i.test(f)) olhados++;
    if (grava && !AINDA_PNG[f]) achados.push(f);
  }
  assert.ok(olhados >= 4, `a varredura achou só ${olhados} arquivo(s) de capa — regex quebrada?`);
  assert.deepStrictEqual(achados, []);
  for (const f of ['coverViralAgent.js', 'coverAgentHTML.js']) {
    assert.match(fs.readFileSync(path.join(pasta, f), 'utf8'), /formatoCapa\.(caminhoDeCapa|opcoesDeCaptura)/, f);
  }
});
