'use strict';
/**
 * HuggingFace ficou meses "sem chave valida" com 6 chaves funcionando: o
 * cliente chamava rotas por provedor que o HF removeu (404) e engolia o erro.
 * Aqui se prova o contrato do cliente novo contra um axios falso:
 * - usa o roteador unificado com o modelo no corpo;
 * - 404 de um modelo passa para o proximo modelo (mesma chave);
 * - 402/429 sobe para a rotacao marcar a CHAVE.
 */
const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { callHuggingFace, MODELOS_HF } = require('../src/core/aiClient');

function comAxiosFalso(respostas, corpo) {
  const original = axios.post;
  const chamadas = [];
  axios.post = async (url, body) => {
    chamadas.push({ url, model: body.model, max_tokens: body.max_tokens });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return { data: { choices: [{ message: { content: r } }] } };
  };
  return corpo(chamadas).finally(() => { axios.post = original; });
}
const erroHttp = status => Object.assign(new Error('status ' + status), { response: { status } });

test('usa o roteador unificado, nunca as rotas antigas por provedor', () =>
  comAxiosFalso(['ok'], async chamadas => {
    assert.strictEqual(await callHuggingFace('p', 's', 'k', { maxTokens: 321 }), 'ok');
    assert.strictEqual(chamadas[0].url, 'https://router.huggingface.co/v1/chat/completions');
    assert.strictEqual(chamadas[0].model, MODELOS_HF[0]);
    assert.strictEqual(chamadas[0].max_tokens, 321);
    assert.ok(!MODELOS_HF.some(m => /SmolLM|Llama-3\.2-3B|llama3\.3-70b$/.test(m)));
  }));

test('404 num modelo tenta o proximo modelo com a mesma chave', () =>
  comAxiosFalso([erroHttp(404), 'segundo'], async chamadas => {
    assert.strictEqual(await callHuggingFace('p', 's', 'k'), 'segundo');
    assert.strictEqual(chamadas.length, 2);
    assert.notStrictEqual(chamadas[0].model, chamadas[1].model);
  }));

test('402 (credito da conta) sobe para a rotacao em vez de queimar os outros modelos', () =>
  comAxiosFalso([erroHttp(402), 'nao deveria chegar'], async chamadas => {
    await assert.rejects(() => callHuggingFace('p', 's', 'k'), e => e.response.status === 402);
    assert.strictEqual(chamadas.length, 1);
  }));
