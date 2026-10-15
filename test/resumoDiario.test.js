'use strict';
/**
 * Resumo diario das lojas: a mesma recusa do KDP aparecia 465 vezes no
 * hotmart_vps.log. Aqui o motivo aparece UMA vez, com a contagem, e cada loja
 * diz o que publicou e o que falhou. As linhas dos casos sao copiadas do log real.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const R = require('../src/agents/resumoDiario');
const S = require('../scripts/resumoDiario');
const { planoDeTentativas, MAX_ENVIOS } = require('../scripts/enviarPdfsRegerados');
const { respostaGuardadaKdp, PRAZO_CACHE_KDP_MS } = require('../src/agents/kdpRegras');

const H = 'hotmart_vps.log';
const KDP = '{"liberada":false,"motivo":"Ação necessária: você inseriu uma conta bancária que não pode receber pagamentos do KDP."}';

test('motivo normalizado: sem data, cor, id e numero longo', () => {
  assert.strictEqual(R.normalizarMotivo('\x1b[31merror\x1b[39m [capasKiwify] ERRO: produto 8672444 id 0c104665-ee04-4964-aab3-e781471f1247'), '[capasKiwify] ERRO: produto N id <id>');
  assert.strictEqual(R.normalizarMotivo('2026-10-15T19:28:08+02:00 GGKEY:SJ22W106K4J falhou'), '<ggkey> falhou');
  assert.strictEqual(R.normalizarMotivo('[2026-10-15 17:21:14] info x'), 'x');
  assert.strictEqual(R.normalizarMotivo(null), '');
  assert.strictEqual(R.normalizarMotivo('livro "' + 'a'.repeat(50) + '" falhou'), 'livro "…" falhou');
});

test('momento: ISO com fuso do laco e colchete UTC do container', () => {
  assert.strictEqual(R.momentoDaLinha('2026-10-15T19:28:08+02:00 kdp: x'), Date.parse('2026-10-15T17:28:08Z'));
  assert.strictEqual(R.momentoDaLinha('[2026-10-15 17:21:14] info [x] y'), Date.parse('2026-10-15T17:21:14Z'));
  assert.strictEqual(R.momentoDaLinha('\x1b[32m[2026-10-15 17:21:14]\x1b[39m y'), Date.parse('2026-10-15T17:21:14Z'), 'cor em volta do colchete nao atrapalha');
  assert.strictEqual(R.momentoDaLinha('sem data'), null);
  assert.strictEqual(R.momentoDaLinha(undefined), null);
});

test('cada tipo de linha do laco vira a conta ou o motivo certo', () => {
  const c = (arq, l) => R.classificar(arq, l);
  assert.deepStrictEqual(c(H, '2026-10-14T23:27:13+02:00 lote 13: TOTAL: 13/18 publicados em 33.2 min'), [{ loja: 'hotmart', conta: { publicados: 13, tentados: 18 } }]);
  assert.deepStrictEqual(c(H, '2026-10-14T22:14:47+02:00 lote 11: sem TOTAL (ver hotmart_vps_lote.log)')[0].loja, 'hotmart');
  assert.match(c(H, '2026-10-14T22:14:47+02:00 lote 11: sem TOTAL (ver hotmart_vps_lote.log)')[0].motivo, /interrompido/);
  assert.match(c(H, '2026-10-13T21:56:01+02:00 a Hotmart pede login — entrar em https://navegador.veloxisit.com.br')[0].motivo, /pede login/);
  assert.deepStrictEqual(c(H, '2026-10-14T23:27:37+02:00 capas hotmart: TOTAL: 18/18 capas em 0.3 min'), [{ loja: 'hotmart', conta: { capas: 18 } }]);
  assert.match(c(H, '2026-10-09T16:18:23+02:00 pdfs hotmart: 8672444 uploadPDF=true API confirma arquivo=false')[0].motivo, /^pdfs hotmart: N uploadPDF=true API confirma arquivo=false$/);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:00+02:00 kiwify: {"publicados":9,"falhas":1,"recusados":0}'), [{ loja: 'kiwify', conta: { publicados: 9, falhas: 1, recusados: 0 } }]);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:00+02:00 kiwify: {}'), [{ loja: 'kiwify', conta: { publicados: 0, falhas: 0, recusados: 0 } }]);
  assert.match(c(H, '2026-10-15T19:27:00+02:00 kiwify: {"publicados":0,"falhas":0,"recusados":0,"pulado":true}')[0].motivo, /limite de produtos da conta/);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:00+02:00 capas kiwify: {"fila":2,"ok":1,"falhas":1}'), [{ loja: 'kiwify', conta: { capas: 1, capasFalhas: 1 } }]);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:00+02:00 capas kiwify: {}'), [{ loja: 'kiwify', conta: { capas: 0, capasFalhas: 0 } }]);
  assert.match(c(H, '2026-10-15T19:28:08+02:00 kdp: ' + KDP)[0].motivo, /^conta nao liberada: Ação necessária: você inseriu uma conta bancária/);
  assert.deepStrictEqual(c(H, '2026-10-15T19:28:08+02:00 kdp: {"liberada":true}'), [{ loja: 'kdp', foto: 'conta liberada' }]);
  assert.match(c(H, '2026-10-15T19:27:49+02:00 gplay: {"publicados":0,"falhas":0,"fila":0,"semSessao":true}')[0].motivo, /sem sessao do Google/);
  assert.match(c(H, '2026-10-15T19:27:49+02:00 gplay: {"publicados":0,"falhas":0,"fila":0,"portao":"em-revisao"}')[0].motivo, /conta em revisao \(portao: em-revisao\)/);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:49+02:00 gplay: {"publicados":2,"falhas":0,"fila":9,"portao":"live"}'), [{ loja: 'gplay', conta: { publicados: 2, falhas: 0 } }]);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:49+02:00 gplay: {}'), [{ loja: 'gplay', conta: { publicados: 0, falhas: 0 } }]);
  assert.deepStrictEqual(c(H, '2026-10-15T19:27:49+02:00 gplay: {quebrado'), [], 'JSON quebrado nao vira conta inventada');
  assert.match(c(H, '2026-10-07T10:00:00+02:00 capas kiwify: [2026-10-07 08:00:00] [31merror[39m [capasKiwify] ERRO: getaddrinfo EAI_AGAIN navegador-hotmart')[0].motivo, /EAI_AGAIN/);
  assert.strictEqual(c(H, '2026-10-07T10:00:00+02:00 capas kiwify: [2026-10-07] ERRO: x')[0].loja, 'kiwify');
  assert.deepStrictEqual(c(H, '2026-10-14T20:14:47+02:00 kiwify: OCI runtime exec failed: exec failed: unable to start container process'), [{ loja: 'infra', motivo: 'comando morto: container recriado no meio (deploy ou reinicio) — kiwify' }]);
  assert.match(c(H, 'cannot exec in a stopped container')[0].motivo, /— laco$/);
  assert.deepStrictEqual(c(H, '2026-10-15T19:00:00+02:00 lote 14: qualquer outra coisa'), []);
});

test('Cakto, recompressao e cadeia da Kiwify', () => {
  const c = R.classificar;
  assert.deepStrictEqual(c('backlog_publish.log', '[2026-10-15 17:21:14] info [publicarCakto] publicado "X" checkout=ozwnepj'), [{ loja: 'cakto', conta: { publicados: 1 } }]);
  assert.deepStrictEqual(c('backlog_publish.log', '[2026-10-15 17:21:14] error [publicarCakto] FALHA "Livro": HTTP 429 em 3 tentativas'), [{ loja: 'cakto', motivo: 'HTTP N em 3 tentativas' }]);
  assert.match(c('backlog_publish.log', '[2026-10-15 17:21:14] warn [publicarCakto] recusado pela Cakto: termo proibido')[0].motivo, /recusado/);
  assert.deepStrictEqual(c('backlog_publish.log', '[2026-10-15 17:21:33] info [publicarCakto] resumo: {"publicados":5,"falhas":0,"recusados":0}'), [], 'resumo nao conta de novo, nem vira recusa pela palavra "recusados"');
  assert.match(c('cakto_checkout.log', '[2026-10-15 02:54:46] info [caktoCheckout] checkout da Cakto: {"livros":16050,"ativos":14708,"motivos":{"produto-waiting_config":1334}}')[0].foto, /14708 ativos de 16050/);
  assert.deepStrictEqual(c('cakto_checkout.log', '[x] checkout da Cakto: {quebrado}'), [], 'JSON quebrado nao vira estado inventado');
  assert.match(c('cakto_checkout.log', '[x] checkout da Cakto: {"livros":1,"ativos":1}')[0].foto, /fora: \{\}/);
  assert.match(c('cakto_checkout.log', '[2026-10-14 19:53:54] error [caktoCheckout] ERRO: CAKTO_HTML: HTTP 429')[0].motivo, /^checkout: /);
  assert.deepStrictEqual(c('cakto_checkout.log', '[x] produtos lidos: 1'), []);
  assert.deepStrictEqual(c('recompressao_pdf.log', '[x] recompressao: {"substituidos":20,"mantidos":2}'), [{ loja: 'pdfs', conta: { recomprimidos: 20, mantidos: 2 } }]);
  assert.deepStrictEqual(c('recompressao_pdf.log', '[x] recompressao: {"substituidos":3}'), [{ loja: 'pdfs', conta: { recomprimidos: 3, mantidos: 0 } }]);
  assert.deepStrictEqual(c('recompressao_pdf.log', '[x] recompressao: {"fila":0,"substituidos":0}'), [], 'rodada vazia nao conta');
  assert.deepStrictEqual(c('recompressao_pdf.log', '[x] outra'), []);
  assert.match(c('kiwify_cadeia.log', '2026-10-15T19:34:24+02:00 resumo da auditoria de entrega (registrado em 15/10): 1446 produtos')[0].foto, /^auditoria de entrega: 1446 produtos/);
  assert.deepStrictEqual(c('kiwify_cadeia.log', '2026-10-14T01:29:30+02:00 fim'), []);
  assert.deepStrictEqual(c('outro.log', 'qualquer'), []);
});

test('agrupa a mesma recusa (uma linha, com contagem e janela) e soma as contas; fora do periodo nao entra', () => {
  const desde = Date.parse('2026-10-15T00:00:00Z'), ate = Date.parse('2026-10-16T00:00:00Z');
  const e = [];
  for (let h = 1; h <= 9; h++) e.push({ arquivo: H, linha: '2026-10-15T0' + h + ':00:00+00:00 kdp: ' + KDP });
  e.push({ arquivo: H, linha: '2026-10-14T23:00:00+00:00 kdp: ' + KDP });   // antes do periodo
  e.push({ arquivo: H, linha: '2026-10-15T10:00:00+00:00 kiwify: {"publicados":9,"falhas":1,"recusados":0}' });
  e.push({ arquivo: H, linha: '2026-10-15T11:00:00+00:00 kiwify: {"publicados":8,"falhas":2,"recusados":1}' });
  e.push({ arquivo: H, linha: 'linha sem data' });
  const lojas = R.agregar(e, { desde, ate });
  const motivos = Object.entries(lojas.kdp.motivos);
  assert.strictEqual(motivos.length, 1, 'a recusa repetida vira UMA linha');
  assert.strictEqual(motivos[0][1].n, 9);
  assert.deepStrictEqual([motivos[0][1].primeira, motivos[0][1].ultima], [Date.parse('2026-10-15T01:00:00Z'), Date.parse('2026-10-15T09:00:00Z')]);
  assert.deepStrictEqual(lojas.kiwify.conta, { publicados: 17, falhas: 3, recusados: 1 });
  const txt = R.formatar(lojas, { desde, ate, extras: { gplay: ['eventos: falha 1'] } });
  assert.match(txt, /^Resumo das lojas — 10-15 00:00 a 10-16 00:00 UTC/);
  assert.match(txt, /## kiwify\n {2}publicados: 17 \| falhas: 3 \| recusados: 1/);
  assert.match(txt, /## kdp\n {2}- conta nao liberada: .* — 9x \(10-15 01:00 a 10-15 09:00\)/);
  assert.strictEqual((txt.match(/conta bancária/g) || []).length, 1, 'a frase do KDP aparece uma vez so');
  assert.match(txt, /## gplay\n {2}eventos: falha 1/);
  assert.ok(txt.indexOf('## kiwify') < txt.indexOf('## kdp'), 'ordem fixa das lojas');
});

test('formatar: motivo de uma vez so, estado, loja sem atividade e periodo vazio', () => {
  const desde = 0, ate = 3600000;
  const txt = R.formatar({ cakto: { conta: {}, motivos: { 'x': { n: 1, primeira: 60000, ultima: 60000 } }, foto: 'checkout na vitrine: 1 ativos' } }, { desde, ate, extras: { outra: [] } });
  assert.match(txt, /- x — 1x \(01-01 00:01\)/);
  assert.match(txt, /estado: checkout na vitrine/);
  assert.match(R.formatar({ vazia: { conta: {}, motivos: {}, foto: null } }, { desde, ate }), /## vazia\n {2}sem atividade/);
  assert.match(R.formatar({}, { desde, ate }), /nenhuma linha no periodo/);
  assert.deepStrictEqual(R.agregar(null, { desde, ate }), {});
});

function banco() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ebooks (id TEXT, gplay_id TEXT, gplay_estado TEXT);
    CREATE TABLE hotmart_publicar_falha (ebook_id TEXT, tentativas INTEGER, erro TEXT, quando INTEGER);
    CREATE TABLE hotmart_pdf_envio (produto TEXT, tentativas INTEGER, quando INTEGER, desistiu INTEGER);
    CREATE TABLE kiwify_falha (ebook_id TEXT, motivo TEXT, tentativas INTEGER, quando INTEGER);
    CREATE TABLE kiwify_recusado (ebook_id TEXT, palavra TEXT, quando INTEGER);
    CREATE TABLE cakto_recusado (ebook_id TEXT, motivo TEXT, quando INTEGER);
    CREATE TABLE gplay_eventos (ebook_id TEXT, gplay_id TEXT, quando INTEGER, dia TEXT, tipo TEXT, detalhe TEXT);`);
  return db;
}

test('script: entrada "arquivo<TAB>linha" + o que o banco sabe, num texto so', () => {
  const agora = Date.parse('2026-10-15T20:00:00Z');
  const db = banco();
  const dentro = agora - 3600000, fora = agora - 30 * 3600000;
  db.prepare('INSERT INTO hotmart_publicar_falha VALUES (?,?,?,?)').run('a', 1, 'Pricing save timeout', dentro);
  db.prepare('INSERT INTO hotmart_publicar_falha VALUES (?,?,?,?)').run('b', 2, 'Pricing save timeout', dentro);
  db.prepare('INSERT INTO hotmart_publicar_falha VALUES (?,?,?,?)').run('c', 3, 'velha', fora);
  db.prepare('INSERT INTO hotmart_pdf_envio VALUES (?,?,?,?)').run('8672444', 5, dentro, 1);
  db.prepare('INSERT INTO kiwify_falha VALUES (?,?,?,?)').run('k', 'sem-entrega: approved_url vazio id=1', 1, dentro);
  db.prepare('INSERT INTO kiwify_recusado VALUES (?,?,?)').run('k2', 'casino', dentro);
  db.prepare('INSERT INTO cakto_recusado VALUES (?,?,?)').run('c1', 'nome repetido', dentro);
  db.prepare('INSERT INTO gplay_eventos VALUES (?,?,?,?,?,?)').run('g', 'GGKEY:X', dentro, '2026-10-15', 'falha', 'x');
  db.prepare('INSERT INTO ebooks VALUES (?,?,?)').run('g', 'GGKEY:X', 'rascunho');
  const texto = H + '\t2026-10-15T19:28:08+00:00 kdp: ' + KDP + '\nsem-tab\n' + H + '\t2026-10-15T19:30:00+00:00 lote 1: TOTAL: 3/4 publicados em 2 min\n';
  const out = S.principal({ texto, db, agora });
  assert.match(out, /## hotmart\n {2}publicados: 3 \| tentados: 4\n {2}falhas registradas no periodo: 2 livro\(s\)\n {4}\* Pricing save timeout — 2x/);
  assert.match(out, /PDF regerado que a API nunca confirmou .*: 1 produto/);
  assert.match(out, /## kiwify\n {2}livros nao gravados como publicados: 1\n {4}\* sem-entrega: approved_url vazio id=1 — 1x\n {2}recusados pelo filtro de conteudo da Kiwify: 1/);
  assert.match(out, /## cakto\n {2}recusados: 1/);
  assert.match(out, /## gplay\n {2}eventos: falha 1\n {2}livros na conta: rascunho 1/);
  assert.match(out, /## kdp\n {2}- conta nao liberada/);
  assert.deepStrictEqual(S.lerEntradas('a\tb\n\tsem arquivo\nsemtab'), [{ arquivo: 'a', linha: 'b' }]);
});

test('script: banco sem as tabelas nao derruba; consulta que falha diz que nao leu', () => {
  const vazio = new Database(':memory:');
  vazio.exec('CREATE TABLE ebooks (id TEXT); CREATE TABLE gplay_eventos (quando INTEGER, tipo TEXT)');
  const out = S.principal({ texto: '', db: vazio, agora: Date.now() });
  assert.match(out, /## resumo\n {2}gplay: nao li/, 'tabela ebooks sem as colunas: a falha aparece');
  assert.doesNotMatch(out, /hotmart: nao li|kiwify: nao li|cakto: nao li/, 'tabela que nao existe e silencio, nao erro');
  const db = banco();
  db.exec('DROP TABLE hotmart_pdf_envio');
  assert.doesNotMatch(S.principal({ texto: '', db, agora: Date.now() }), /PDF regerado/);
  const semKiwifyFalha = banco();
  semKiwifyFalha.exec('DROP TABLE kiwify_falha; DROP TABLE kiwify_recusado; DROP TABLE hotmart_publicar_falha');
  assert.match(S.principal({ texto: '', db: semKiwifyFalha, agora: Date.now() }), /nenhuma linha no periodo/);
});

test('reenvio de PDF da Hotmart: confirmado sai, nao confirmado conta, no teto desiste', () => {
  assert.strictEqual(MAX_ENVIOS, 5);
  const p = planoDeTentativas({ enviados: ['1', '2', '3'], confirmados: ['2'], tentativas: { 1: 0, 3: 4 } });
  assert.deepStrictEqual(p, { limpar: ['2'], incrementar: [{ produto: '1', tentativas: 1 }, { produto: '3', tentativas: 5 }], desistir: ['3'] });
  assert.deepStrictEqual(planoDeTentativas({ enviados: [8672444], confirmados: [], tentativas: {} }).incrementar, [{ produto: '8672444', tentativas: 1 }]);
  assert.deepStrictEqual(planoDeTentativas(), { limpar: [], incrementar: [], desistir: [] });
  assert.deepStrictEqual(planoDeTentativas({ enviados: ['9'], tentativas: { 9: 'x' }, max: 1 }).desistir, ['9'], 'tentativa ilegivel conta como zero');
});

test('KDP: recusa guardada vale 3 h; conta liberada nunca vem do guardado', () => {
  const agora = Date.parse('2026-10-15T12:00:00Z');
  const recusa = { liberada: false, motivo: 'conta bancaria', quando: agora - 60000 };
  assert.deepStrictEqual(respostaGuardadaKdp(recusa, agora), { liberada: false, motivo: 'conta bancaria', guardada: true });
  assert.strictEqual(respostaGuardadaKdp({ ...recusa, quando: agora - PRAZO_CACHE_KDP_MS }, agora), null, 'no prazo exato confere de novo');
  assert.strictEqual(respostaGuardadaKdp({ ...recusa, quando: agora + 60000 }, agora), null, 'relogio para tras nao vale');
  assert.strictEqual(respostaGuardadaKdp({ liberada: true, quando: agora }, agora), null);
  assert.strictEqual(respostaGuardadaKdp({ ...recusa, quando: 'x' }, agora), null);
  assert.strictEqual(respostaGuardadaKdp(null, agora), null);
  assert.strictEqual(PRAZO_CACHE_KDP_MS, 3 * 3600 * 1000);
  assert.ok(respostaGuardadaKdp({ liberada: false, quando: Date.now() - 1000 }), 'agora padrao = relogio');
});

test('bordas do resumo: linha nula, JSON quebrado, estado e varios motivos na mesma loja', () => {
  assert.deepStrictEqual(R.classificar(H, null), []);
  assert.deepStrictEqual(R.classificar(H, '2026-10-15T19:27:00+02:00 kiwify: {quebrado}'), []);
  assert.deepStrictEqual(R.classificar('recompressao_pdf.log', '[x] recompressao: {quebrado}'), []);
  const desde = Date.parse('2026-10-15T00:00:00Z'), ate = Date.parse('2026-10-16T00:00:00Z');
  const lojas = R.agregar([
    { arquivo: H, linha: '2026-10-15T01:00:00+00:00 kdp: {"liberada":true}' },
    { arquivo: H, linha: '2026-10-15T02:00:00+00:00 gplay: {"semSessao":true}' },
    { arquivo: H, linha: '2026-10-15T03:00:00+00:00 gplay: {"portao":"em-revisao"}' },
    { arquivo: H, linha: '2026-10-15T04:00:00+00:00 gplay: {"semSessao":true}' },
  ], { desde, ate });
  assert.strictEqual(lojas.kdp.foto, 'conta liberada');
  const txt = R.formatar(lojas, { desde, ate });
  assert.ok(txt.indexOf('sem sessao do Google') < txt.indexOf('conta em revisao'), 'o motivo mais repetido vem primeiro');
});
