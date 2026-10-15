'use strict';
/**
 * Google Play Livros: a conta esta em revisao preliminar com um livro, e a
 * primeira impressao conta. Cada trava aqui e o que impede o publicador de
 * estragar isso: portao, teto, parada por reprovacao, nunca editar livro ja
 * enviado, e nada de alegacao sem lastro no texto ao leitor.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../src/agents/gplayRegras');

const DESCR = 'Este guia mostra como montar um roteiro pelo Brasil com pouco dinheiro, do planejamento da rota a escolha de hospedagem. ' +
  'Cada capitulo traz um passo pratico e um exemplo de orcamento. Voce aprende a comparar passagens e a cozinhar na estrada.';

test('idioma: nome exato da lista do Google; sem mapeamento nao publica', () => {
  assert.strictEqual(R.idiomaGoogle('pt-BR'), 'Portuguese');
  assert.strictEqual(R.idiomaGoogle('nl'), 'Dutch; Flemish', 'medido no autocomplete');
  assert.strictEqual(R.idiomaGoogle('ja'), null, 'capa sem fonte para japones');
  assert.strictEqual(R.idiomaGoogle(null), null);
});

test('generos: dois, sempre da tabela conferida, do especifico ao geral', () => {
  const cod = (t, ti) => R.generosDoLivro(t, ti).map(g => g.codigo);
  assert.deepStrictEqual(cod('Como viajar barato e bem pelo Brasil', 'Viajar barato e bem pelo Brasil'), ['TRV024020', 'TRV033000'], 'o par do primeiro livro');
  assert.deepStrictEqual(cod('Mochilao pela Europa'), ['TRV033000', 'TRV000000'], 'viagem sem Brasil nao e Brasil');
  assert.deepStrictEqual(cod('Como ganhar dinheiro com inteligência artificial em 2026'), ['COM004000', 'BUS025000']);
  assert.deepStrictEqual(cod('Inteligência artificial para professores'), ['COM004000', 'COM000000'], 'IA sem dinheiro');
  assert.deepStrictEqual(cod('Inteligência emocional: desenvolver e aplicar'), ['SEL027000', 'SEL000000'], 'emocional nao e IA');
  assert.deepStrictEqual(cod('Educação financeira e saída das dívidas'), ['BUS050030', 'BUS050000']);
  assert.deepStrictEqual(cod('Tesouro Direto passo a passo'), ['BUS036000', 'BUS050000'], 'investimento antes de financas');
  assert.deepStrictEqual(cod('Receitas veganas ricas em proteína'), ['CKB125000', 'CKB000000'], 'vegano antes de receita');
  assert.deepStrictEqual(cod('Assunto que nenhuma regra conhece'), ['SEL000000', 'EDU000000'], 'na duvida, o geral');
  for (const [, , codigos] of R.REGRAS_BISAC) for (const c of codigos) assert.ok(R.BISAC[c], 'codigo fora da tabela conferida: ' + c);
  assert.strictEqual(R.opcaoDoGenero('TRV033000'), '(TRV033000) Travel / Special Interest / Budget', 'texto exato da opcao');
});

test('descricao: sai a frase com alegacao, fica o resto (inclusive "melhor" sem artigo)', () => {
  const r = R.limparDescricao('Dicas testadas por viajantes experientes. Aprenda a planejar.\n\nEconomize 40% na passagem! O melhor guia do país. Viver melhor é possível. Escrito com inteligência artificial.');
  assert.strictEqual(r.texto, 'Aprenda a planejar.\n\nViver melhor é possível.');
  assert.strictEqual(r.removidas, 4);
  for (const f of ['Recomendado por especialistas.', 'Resultados garantidos.', 'Método comprovado.', 'The best guide.', 'Tested by experts.',
    'Este é o livro número 1.', 'Gerado por IA.', 'Nº 1 em vendas.', 'Bestseller absoluto.'])
    assert.strictEqual(R.limparDescricao(f).texto, '', 'devia sair: ' + f);
  for (const f of ['Um livro sobre inteligência artificial no trabalho.', 'Para quem quer viver melhor.', 'Guia em 10 capítulos.'])
    assert.strictEqual(R.limparDescricao(f).texto, f, 'devia ficar: ' + f);
  assert.deepStrictEqual(R.limparDescricao(null), { texto: '', removidas: 0 });
});

test('titulo com promessa numerica sem lastro fica fora', () => {
  for (const t of ['Ganhe +50% de produtividade', 'Emagreça em 7 dias', 'Fluent in 30 days', 'Lucre 3x mais', 'Renda de R$ 5.000', 'Método comprovado'])
    assert.ok(R.tituloComPromessa(t), t);
  for (const t of ['Viajar barato e bem pelo Brasil', '365 Dias com Deus', 'Guia de 2026', 'Em 2 idiomas'])
    assert.ok(!R.tituloComPromessa(t), t);
});

test('quem vai: so livro avulso, com idioma, arquivos, titulo limpo e descricao que sobra', () => {
  const ok = { title: 'Viajar barato', language: 'pt-BR', description: DESCR };
  assert.strictEqual(R.motivoParaNaoPublicar(ok), null);
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, combo_de: 'x' }), 'combo', 'link para conteudo pago fora da loja');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, audio_de: 'x' }), 'audiolivro');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, title: ' ' }), 'sem-titulo');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, language: 'zh' }), 'idioma-sem-mapeamento');
  assert.strictEqual(R.motivoParaNaoPublicar(ok, { temPdf: false }), 'sem-pdf');
  assert.strictEqual(R.motivoParaNaoPublicar(ok, { temCapa: false }), 'sem-capa');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, title: 'Emagreça em 7 dias' }), 'titulo-com-promessa');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, subtitle: '+50% de energia' }), 'titulo-com-promessa', 'o subtitulo tambem');
  const quaseSoAlegacao = 'Guia pratico de viagem. ' + 'Testado por especialistas em cada pagina com cuidado e atencao aos detalhes. '.repeat(5);
  assert.ok(quaseSoAlegacao.length > R.MINIMO_DESCRICAO);
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, description: quaseSoAlegacao }), 'descricao-curta', 'o que conta e o que SOBRA');
  assert.strictEqual(R.motivoParaNaoPublicar(null), 'sem-titulo');
});

test('fila: rascunho aberto, depois venda real, depois pt com texto, depois o resto; mais recente primeiro', () => {
  // Entrada na ordem CONTRARIA a esperada: sort estavel nao pode dar a resposta por acaso.
  const l = [
    { id: 'resto-velho', rowid: 1, language: 'pt' }, { id: 'resto-novo', rowid: 9, language: 'en' },
    { id: 'pt-texto', rowid: 2, language: 'pt-BR' }, { id: 'en-texto', rowid: 8, language: 'en' },
    { id: 'vendido', rowid: 3, language: 'en' }, { id: 'rascunho', rowid: 4, gplay_id: 'GGKEY:AAAAAAA' }, null,
  ];
  const r = R.ordenarFila(l, { vendidos: new Set(['vendido']), comTexto: new Set(['pt-texto', 'en-texto']) }).map(x => x.id);
  assert.deepStrictEqual(r, ['rascunho', 'vendido', 'pt-texto', 'resto-novo', 'en-texto', 'resto-velho']);
  assert.deepStrictEqual(R.ordenarFila(null), []);
  assert.deepStrictEqual(R.ordenarFila([{ id: 'a' }, { id: 'b', rowid: 2 }]).map(x => x.id), ['b', 'a']);
});

test('rodada: parada por reprovacao, portao, teto e vagas', () => {
  assert.deepStrictEqual(R.decidirRodada({ seguidas: 3, portao: 'live' }), { acao: 'parar', vagas: 0 });
  assert.deepStrictEqual(R.decidirRodada({ seguidas: 3, seco: true }), { acao: 'parar', vagas: 0 }, 'nem o dry-run passa da parada');
  assert.deepStrictEqual(R.decidirRodada({ seguidas: 2, portao: 'em-revisao' }), { acao: 'esperar-conta', vagas: 0 });
  assert.deepStrictEqual(R.decidirRodada({ portao: 'desconhecido' }), { acao: 'esperar-conta', vagas: 0 }, 'nao ler o estado nunca libera');
  assert.deepStrictEqual(R.decidirRodada({ portao: 'em-revisao', seco: true, limite: 1 }), { acao: 'publicar', vagas: 1 }, 'dry-run vai ate o Review');
  assert.deepStrictEqual(R.decidirRodada({ portao: 'live', hoje: 2, teto: 2 }), { acao: 'teto', vagas: 0 });
  assert.deepStrictEqual(R.decidirRodada({ portao: 'live', hoje: 1, teto: 2, limite: 5 }), { acao: 'publicar', vagas: 1 }, 'so o que cabe no dia');
  assert.deepStrictEqual(R.decidirRodada({ portao: 'live', hoje: 0, teto: 3, limite: 2 }), { acao: 'publicar', vagas: 2 });
  assert.deepStrictEqual(R.decidirRodada(), { acao: 'esperar-conta', vagas: 0 });
  assert.deepStrictEqual(R.decidirRodada({ portao: 'live', seco: true, limite: 0 }), { acao: 'publicar', vagas: 1 });
  assert.strictEqual(R.cabeHoje(1, 2), true);
  assert.strictEqual(R.cabeHoje(2, 2), false);
  assert.strictEqual(R.cabeHoje(1, 'x'), true, 'teto invalido cai no padrao (2)');
  assert.strictEqual(R.cabeHoje(2, -1), false);
});

test('reprovacoes seguidas: aprovacao zera, outros eventos nao contam', () => {
  assert.strictEqual(R.reprovacoesSeguidas(['reprovado', 'reprovado', 'live', 'reprovado']), 1);
  assert.strictEqual(R.reprovacoesSeguidas(['live', 'reprovado', 'publicado', 'reprovado', 'reprovado']), 3);
  assert.strictEqual(R.reprovacoesSeguidas(null), 0);
});

test('estado na revisao: "not live" e revisao; desconhecido e desconhecido', () => {
  const real = 'error_outline Your book is not live Book status error_outline Your account is not yet approved Learn more';
  assert.strictEqual(R.estadoNaRevisao(real), 'em-revisao', 'o texto medido em 13/10/2026');
  assert.strictEqual(R.estadoNaRevisao('Your book is not live. Book rejected for policy violation'), 'reprovado');
  assert.strictEqual(R.estadoNaRevisao('Your book is live on Google Play'), 'live');
  assert.strictEqual(R.estadoNaRevisao('View on Google Play'), 'live');
  assert.strictEqual(R.estadoNaRevisao('Loading'), 'desconhecido');
  assert.strictEqual(R.estadoNaRevisao(null), 'desconhecido');
});

test('estado na lista e o que fazer com livro achado pelo titulo', () => {
  assert.strictEqual(R.estadoNaLista('sync Pending account review'), 'em-revisao');
  assert.strictEqual(R.estadoNaLista('Rejected'), 'reprovado');
  assert.strictEqual(R.estadoNaLista('Draft'), 'rascunho');
  assert.strictEqual(R.estadoNaLista('Live'), 'live');
  assert.strictEqual(R.estadoNaLista(''), 'desconhecido');
  assert.deepStrictEqual(R.oQueFazerComAchado('Draft'), { acao: 'adotar', estado: 'rascunho' });
  assert.deepStrictEqual(R.oQueFazerComAchado('sync Pending account review'), { acao: 'registrar', estado: 'enviado' }, 'ja enviado nunca e editado');
  assert.deepStrictEqual(R.oQueFazerComAchado('Live'), { acao: 'registrar', estado: 'live' });
  assert.deepStrictEqual(R.oQueFazerComAchado('???'), { acao: 'ignorar', estado: 'desconhecido' });
});

test('GGKEY e url publica: o GGKEY nao e o id da pagina publica', () => {
  assert.strictEqual(R.ggkeyDe('#book/GGKEY:SJ22W106K4J/info/about'), 'GGKEY:SJ22W106K4J');
  assert.strictEqual(R.ggkeyDe('#book/create'), null);
  assert.strictEqual(R.urlPublicaDe('https://play.google.com/store/books/details?id=AbCdEf123456&hl=pt'), 'https://play.google.com/store/books/details?id=AbCdEf123456');
  assert.strictEqual(R.urlPublicaDe('https://play.google.com/store/books/details?id=GGKEY:SJ22W106K4J'), null);
  assert.strictEqual(R.urlPublicaDe('https://play.google.com/store/apps/details?id=AbCdEf123456'), null);
  assert.strictEqual(R.urlPublicaDe(null), null);
  assert.match(R.diaDoNegocio(new Date('2026-10-14T02:30:00Z')), /^2026-10-13$/, '23h30 em Sao Paulo ainda e o dia 13');
});

test('conteudo: processado, processando (nao reenvia), falhou e ausente, com os textos medidos', () => {
  const processado = 'Processed content FILE NAME DISPLAY VERSION TIME RECEIVED ORIGINAL SIZE DETECTED PAGES STATUS insert_drive_file GGKEY:SJ22W106K4J.pdf Fixed 1 2026-10-13 09:52:47 AM 98KB 38 Success Cover files FILE NAME TIME RECEIVED ORIGINAL SIZE insert_drive_file GGKEY:SJ22W106K4J_frontcover.jpg';
  const pendente = 'Pending content FILE NAME DISPLAY VERSION TIME RECEIVED ORIGINAL SIZE DETECTED PAGES STATUS insert_drive_file GGKEY:RZ7E9AGXWKZ.pdf Fixed 1 2026-10-13 05:02:17 PM 88KB 25 Completed step 5 of 6 Cover files FILE NAME TIME RECEIVED ORIGINAL SIZE insert_drive_file GGKEY:RZ7E9AGXWKZ_frontcover.jpg 2026-10-13 05:02:17 PM 332KB';
  assert.deepStrictEqual(R.estadoDoConteudo(processado), { pdf: 'processado', capa: true });
  assert.deepStrictEqual(R.estadoDoConteudo(pendente), { pdf: 'processando', capa: true, detalhe: 'Completed step 5 of 6' });
  assert.strictEqual(R.estadoDoConteudo('Pending content insert_drive_file X.pdf Fixed 1 Failed: invalid file Cover files').pdf, 'falhou');
  assert.strictEqual(R.estadoDoConteudo('Processed content insert_drive_file X.pdf Fixed 1 Error Cover files').pdf, 'falhou', 'processado sem Success');
  assert.deepStrictEqual(R.estadoDoConteudo('A content file is missing No files uploaded yet'), { pdf: 'ausente', capa: false });
  assert.strictEqual(R.estadoDoConteudo('Processed content X.pdf 38 Success').pdf, 'processado', 'sem bloco de capa');
  assert.strictEqual(R.estadoDoConteudo('Pending content X.pdf Completed step 2 of 6 Cover files').capa, false);
  assert.strictEqual(R.estadoDoConteudo('Pending content X.pdf').detalhe, '', 'sem passo escrito');
  assert.deepStrictEqual(R.estadoDoConteudo(null), { pdf: 'ausente', capa: false });
});

test('sessao: a escolha de conta do Google e pedido de login', () => {
  assert.strictEqual(R.pedeLogin('https://accounts.google.com/v3/signin/accountchooser?continue=https://play.google.com/books/publish'), true);
  assert.strictEqual(R.pedeLogin('https://play.google.com/books/publish/u/0/a/1#list'), false);
  assert.strictEqual(R.pedeLogin(null), false);
});

test('bordas: sem topico nem titulo, sem rowid, sem texto, limite invalido', () => {
  assert.deepStrictEqual(R.generosDoLivro(null, null).map(g => g.codigo), ['SEL000000', 'EDU000000']);
  assert.deepStrictEqual(R.ordenarFila([{ id: 'x' }, { id: 'y' }]).map(l => l.id), ['x', 'y'], 'sem rowid nenhum, ordem mantida');
  assert.strictEqual(R.ggkeyDe(null), null);
  assert.deepStrictEqual(R.decidirRodada({ portao: 'live', limite: 0, teto: 2 }), { acao: 'publicar', vagas: 1 }, 'limite invalido vira 1');
});


test('lista reescrita pela aplicacao conta como carregada; outra aba nao', () => {
  assert.strictEqual(R.hashConfere('#list?sortby=last_updated&sortdir=desc', 'list'), true, 'o endereco medido em 15/10/2026');
  assert.strictEqual(R.hashConfere('#book/GGKEY:AB12CD/review', 'book/GGKEY:AB12CD/review'), true);
  assert.strictEqual(R.hashConfere('#listagem', 'list'), false);
  assert.strictEqual(R.hashConfere('#book/GGKEY:AB12CD/info/about', 'book/GGKEY:AB12CD/review'), false);
  assert.strictEqual(R.hashConfere('', 'list'), false);
  assert.strictEqual(R.hashConfere('#list', ''), false, 'sem pedido nao confere');
  assert.strictEqual(R.hashConfere(null, null), false);
});

test('livro que ja passou pela loja nunca volta para a fila; so o rascunho e retomado', () => {
  const ok = { title: 'Viajar barato', language: 'pt-BR', description: 'Um guia pratico para viajar pelo Brasil gastando pouco, do planejamento da rota a escolha de hospedagem. Cada capitulo traz um passo pratico e um exemplo de orcamento para a viagem inteira, com a lista do que levar.' };
  assert.strictEqual(R.motivoParaNaoPublicar(ok), null);
  for (const estado of ['live', 'enviado', 'em-revisao', 'reprovado', 'registrado'])
    assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, gplay_estado: estado }), 'ja-na-loja', estado);
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, gplay_id: 'GGKEY:SJ22W106K4J', gplay_estado: 'live' }), 'ja-na-loja', 'o primeiro livro, no ar');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, gplay_id: 'GGKEY:RZ7E9AGXWKZ', gplay_estado: null }), 'ja-na-loja', 'GGKEY sem estado: nao arrisca outro produto');
  assert.strictEqual(R.motivoParaNaoPublicar({ ...ok, gplay_id: 'GGKEY:AAAAAAA', gplay_estado: 'rascunho' }), null, 'rascunho e retomado');
});
