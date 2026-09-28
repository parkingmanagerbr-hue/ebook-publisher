'use strict';
/**
 * indexNow: avisar buscador sem credencial do dono. A regra que protege o
 * site: nunca enviar URL de outro dominio (o pedido inteiro e recusado, 422) e
 * nunca prometer envio sem chave valida.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { chaveValida, arquivoDaChave, urlsParaEnviar, corpoDoPedido, lerResposta } = require('../src/agents/indexNow');

const CHAVE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('a chave segue o formato do protocolo', () => {
  assert.strictEqual(chaveValida(CHAVE), true);
  assert.strictEqual(chaveValida('abc123'), false, 'menos de 8 caracteres');
  assert.strictEqual(chaveValida('nao-hexadecimal-zzz'), false);
  assert.strictEqual(chaveValida(''), false);
  assert.strictEqual(chaveValida(null), false);
  assert.strictEqual(chaveValida('f'.repeat(129)), false, 'mais de 128');
  assert.strictEqual(chaveValida('F'.repeat(32)), true, 'maiuscula tambem e hexadecimal');
});

test('o arquivo publicado tem o nome e o conteudo da chave', () => {
  assert.deepStrictEqual(arquivoDaChave(CHAVE), { nome: CHAVE + '.txt', conteudo: CHAVE });
  assert.strictEqual(arquivoDaChave('curta'), null, 'chave invalida nao vira arquivo');
});

test('URL de OUTRO dominio nunca e enviada (derruba o pedido inteiro)', () => {
  const urls = [
    'https://veloxisit.com.br/livros/a/',
    'https://site-de-terceiro.com/x',
    'https://veloxisit.com.br.invasor.com/y',
  ];
  assert.deepStrictEqual(urlsParaEnviar(urls, 'veloxisit.com.br'), ['https://veloxisit.com.br/livros/a/']);
});

test('so https, sem repetidas, e respeitando o teto de 10.000', () => {
  const urls = [
    'https://veloxisit.com.br/a/',
    'https://veloxisit.com.br/a/',
    'http://veloxisit.com.br/inseguro/',
    'nao-e-url',
  ];
  assert.deepStrictEqual(urlsParaEnviar(urls, 'veloxisit.com.br'), ['https://veloxisit.com.br/a/']);
  const muitas = Array.from({ length: 12000 }, (_, i) => 'https://veloxisit.com.br/p' + i + '/');
  assert.strictEqual(urlsParaEnviar(muitas, 'veloxisit.com.br').length, 10000);
  assert.strictEqual(urlsParaEnviar(muitas, 'veloxisit.com.br', 50).length, 50);
  assert.strictEqual(urlsParaEnviar(muitas, 'veloxisit.com.br', 0).length, 10000, 'teto invalido cai no padrao');
});

test('host aceita com ou sem esquema, e vazio nao envia nada', () => {
  const u = ['https://veloxisit.com.br/a/'];
  assert.strictEqual(urlsParaEnviar(u, 'https://veloxisit.com.br/').length, 1);
  assert.strictEqual(urlsParaEnviar(u, 'VELOXISIT.COM.BR').length, 1);
  assert.deepStrictEqual(urlsParaEnviar(u, ''), []);
  assert.deepStrictEqual(urlsParaEnviar(u, null), []);
  assert.deepStrictEqual(urlsParaEnviar(null, 'veloxisit.com.br'), []);
});

test('o corpo do pedido aponta para o arquivo da chave', () => {
  const c = corpoDoPedido({ host: 'veloxisit.com.br', chave: CHAVE, urls: ['https://veloxisit.com.br/livros/'] });
  assert.strictEqual(c.host, 'veloxisit.com.br');
  assert.strictEqual(c.key, CHAVE);
  assert.strictEqual(c.keyLocation, 'https://veloxisit.com.br/' + CHAVE + '.txt');
  assert.deepStrictEqual(c.urlList, ['https://veloxisit.com.br/livros/']);
});

test('sem chave valida ou sem URL propria, NAO se monta pedido', () => {
  assert.strictEqual(corpoDoPedido({ host: 'veloxisit.com.br', chave: 'curta', urls: ['https://veloxisit.com.br/a/'] }), null);
  assert.strictEqual(corpoDoPedido({ host: 'veloxisit.com.br', chave: CHAVE, urls: [] }), null);
  assert.strictEqual(corpoDoPedido({ host: 'veloxisit.com.br', chave: CHAVE, urls: ['https://outro.com/a'] }), null);
  assert.strictEqual(corpoDoPedido({}), null);
});

test('a resposta e lida pelo codigo, e 202 tambem e sucesso', () => {
  assert.strictEqual(lerResposta(200).ok, true);
  assert.strictEqual(lerResposta(202).ok, true);
  assert.match(lerResposta(202).motivo, /verificacao/);
  assert.strictEqual(lerResposta(403).ok, false);
  assert.match(lerResposta(403).motivo, /chave nao confere/);
  assert.match(lerResposta(422).motivo, /fora do host/);
  assert.match(lerResposta(429).motivo, /ritmo/);
  assert.match(lerResposta(400).motivo, /malformado/);
  assert.match(lerResposta(500).motivo, /inesperada: 500/);
  assert.match(lerResposta(null).motivo, /inesperada: \?/);
});

test('sem resposta nenhuma nao vira "codigo 0"', () => {
  assert.match(lerResposta(undefined).motivo, /inesperada: \?/);
  assert.match(lerResposta('').motivo, /inesperada: \?/);
  assert.match(lerResposta('abc').motivo, /inesperada: \?/);
  assert.match(lerResposta(0).motivo, /inesperada: 0/, 'zero de verdade aparece como 0');
});

test('URL com host igual mas porta ou caminho estranho ainda e nossa', () => {
  assert.strictEqual(urlsParaEnviar(['https://veloxisit.com.br/livros/x/?utm=1'], 'veloxisit.com.br').length, 1);
  assert.strictEqual(urlsParaEnviar(['https://sub.veloxisit.com.br/a'], 'veloxisit.com.br').length, 0, 'subdominio e outro host');
});

test('item nulo na lista e URL impossivel nao quebram o envio', () => {
  const urls = [null, undefined, 'https://veloxisit.com.br/ok/', 'https://[invalida', 'https://veloxisit.com.br:70000/x'];
  assert.deepStrictEqual(urlsParaEnviar(urls, 'veloxisit.com.br'), ['https://veloxisit.com.br/ok/']);
});
