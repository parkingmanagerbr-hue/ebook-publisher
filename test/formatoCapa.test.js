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

test('capa montada em Canvas sai em JPEG, não em PNG', () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(40, 60);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, 40, 60);
  const buf = F.codificarCanvas(c);
  assert.strictEqual(buf[0], 0xff);
  assert.strictEqual(buf[1], 0xd8, 'assinatura JPEG');
});

// Geradores que ainda gravam PNG e por quê. Entrar aqui exige motivo escrito.
// 09/11/2026: o coverAgent estava aqui como "sem uso" e gravou duas capas PNG no
// mesmo dia (reserva quando a viral e a HTML falham). Exceção só com medição.
const AINDA_PNG = {
  'claudeDesignAgent.js': 'sem chave da Anthropic no produto; não gera capa em produção',
};

test('nenhum gerador de capa em uso volta a gravar PNG', () => {
  const pasta = path.join(__dirname, '..', 'src', 'agents');
  const achados = [];
  let olhados = 0;
  for (const f of fs.readdirSync(pasta).filter((n) => n.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(pasta, f), 'utf8');
    const grava = /cover[a-z_]*_\$\{Date\.now\(\)\}\.png|type:\s*'png'|toBuffer\(\s*'image\/png'/.test(txt) && /cover/i.test(f);
    if (/cover|capa|design/i.test(f)) olhados++;
    if (grava && !AINDA_PNG[f]) achados.push(f);
  }
  assert.ok(olhados >= 4, `a varredura achou só ${olhados} arquivo(s) de capa — regex quebrada?`);
  assert.deepStrictEqual(achados, []);
  for (const f of ['coverViralAgent.js', 'coverAgentHTML.js', 'coverAgent.js']) {
    assert.match(fs.readFileSync(path.join(pasta, f), 'utf8'), /formatoCapa\.(caminhoDeCapa|opcoesDeCaptura)/, f);
  }
});
