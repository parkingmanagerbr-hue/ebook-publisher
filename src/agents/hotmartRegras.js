'use strict';
/**
 * hotmartRegras.js — decisoes puras do cadastro na Hotmart, fora do navegador.
 *
 * Moravam dentro de publisherHotmart.js (2300 linhas de Puppeteer), onde nao
 * havia como testar. O publisher continua chamando e reexportando estas funcoes.
 */

const TECH_KW = ['web3','blockchain','programar','chatbot','cloud','saas','tecnologia','inteligencia artificial',' ia ','python','javascript','codigo','algoritmo','digital','nft','criptomoeda','linux','docker'];
const HEALTH_KW = ['saude','sono','depressao','panico','menopausa','hipertrofia','pressao','alcalina','alimentac','dieta','emagrecimento','fitness','exercicio','musculacao','mental','ansiedade','yoga','meditacao','hormonio','diabetes','colesterol'];
const FINANCE_KW = ['investimento','financ','dinheiro','consorcio','franquia','airbnb','freelancer','renda','patrimonio','aposentadoria','acoes','fundo','bitcoin','trading','bolsa','credito','emprestimo'];
const BUSINESS_KW = ['nomade','negocio','empreend','carreira','marketing','vendas','produtividade','lideranca','gestao','startup','cliente','lucro','estrategia','branding','copywriting','persona'];

function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

/** Texto normalizado, so letras e numeros, com espaco nas pontas para casar palavra. */
function emPalavras(s) {
  return ' ' + norm(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/**
 * A palavra-chave aparece no texto?
 *
 * Era `includes` puro, e palavra-chave curta dentro de outra palavra mandava o
 * livro para a categoria errada: "aprenda" tem "renda" (Negocios), "relacoes" e
 * "meditacoes" tem "acoes", "profundo" tem "fundo", "acredito" tem "credito",
 * "fundamental" tem "mental" e "expressao" tem "pressao" (Saude).
 *
 * Regra: chave curta (ate 7 letras) so casa no COMECO de uma palavra; chave
 * longa continua casando dentro de composta ("microempreendedor" e negocio,
 * "neuromarketing" tambem); chave escrita com espacos (" ia ") e palavra
 * inteira — a sigla IA nao pode casar "tia" nem "culinaria", mas precisa casar
 * "IA para Iniciantes", que a versao anterior perdia por exigir espaco antes.
 */
function casaPalavra(texto, chave) {
  const k = chave.trim();
  if (k !== chave) return texto.includes(' ' + k + ' ');
  if (k.length >= 8) return texto.includes(k);
  return texto.includes(' ' + k);
}

function getCategoryPT(title, topic) {
  const t = emPalavras(title + ' ' + (topic || ''));
  if (TECH_KW.some(k => casaPalavra(t, k)))     return 'Tecnologia e Programacao';
  if (HEALTH_KW.some(k => casaPalavra(t, k)))   return 'Saude e Esportes';
  if (FINANCE_KW.some(k => casaPalavra(t, k)))  return 'Negocios e Carreira';
  if (BUSINESS_KW.some(k => casaPalavra(t, k))) return 'Negocios e Carreira';
  return 'Desenvolvimento Pessoal';
}

/**
 * Digitos que se digitam no campo de preco da Hotmart. A mascara e da direita
 * para a esquerda (os dois ultimos digitos sao os centavos), entao o valor tem
 * de virar CENTAVOS: `replace(/[^0-9]/g,'')` puro transformava HOTMART_PRICE=5
 * em R$ 0,05 e 30 em R$ 0,30. Producao usa "5,00", onde os dois davam o mesmo.
 */
function digitosDoPreco(texto) {
  const s = String(texto == null ? '' : texto).replace(/[^0-9.,]/g, '');
  if (!s.replace(/[.,]/g, '')) return '';
  const comCentavos = s.match(/^(.*?)[.,](\d{1,2})$/);
  const reais = Number((comCentavos ? comCentavos[1] : s).replace(/[.,]/g, '') || '0');
  const centavos = comCentavos ? Number(comCentavos[2].padEnd(2, '0')) : 0;
  return String(reais * 100 + centavos);
}

/** Id numerico do produto na URL do wizard/gestao, ou null. */
function idProdutoDaUrl(u) {
  const m = u.match(/\/products\/manage\/(\d+)/) || u.match(/\/products\/add\/4\/[^\/]+\/(\d+)/) || u.match(/[?&]productId=(\d+)/) || u.match(/\/(\d{7,})(?:\/|$|\?)/);
  return m ? m[1] : null;
}

/** Comparacao de nome de produto: acento, caixa e espaco nao contam. */
function nomeComparavel(t) {
  return String(t == null ? '' : t).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * O produto aberto e mesmo o livro que vamos enviar?
 *
 * 22/09/2026: quando o cadastro nao capturava o id, a busca de reserva devolvia
 * OUTRO produto da conta — tres livros diferentes tiveram o PDF enviado para o
 * 8452258 ("Orcamento de Viagem de Luxo") e o comprador receberia o livro
 * errado. Sem nome (API nao respondeu) nao da para afirmar que esta errado:
 * segue, porque bloquear toda publicacao por uma consulta que falhou e pior.
 * Pura.
 */
function mesmoProduto(nomeNoHotmart, titulo) {
  const a = nomeComparavel(nomeNoHotmart);
  if (!a) return true;
  return a === nomeComparavel(titulo);
}

/** Uma linha de log nunca pode vir com quebra: o valor do usuario forjaria outra. */
function umaLinha(s, limite = 60) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, limite);
}

/** Motivo do bloqueio, pronto para o log e para a mensagem do erro. Pura. */
function motivoProdutoErrado(id, nomeNoHotmart, titulo) {
  return 'PRODUTO_ERRADO: id ' + umaLinha(id, 20) + ' e "' + umaLinha(nomeNoHotmart) +
    '", nao "' + umaLinha(titulo) + '" — nada enviado';
}

/** Aviso de termos da Hotmart por cima do wizard (bloqueia o cadastro). Pura. */
function ehAvisoDeTermos(textoDaPagina) {
  const t = String(textoDaPagina || '');
  return /Termos? (foram|foi) atualizad|Termo de Uso [ÉE]tico|pol[íi]tica de pagamentos/i.test(t)
    && /OK, Entendi|Aceitar|Concordo/i.test(t);
}

/** Texto do botao que fecha o aviso. Pura (usada tambem dentro da pagina). */
function ehBotaoDeAviso(texto) {
  return /^(OK,?\s*)?(Entendi|Aceitar|Concordo)$/i.test(String(texto || '').replace(/\s+/g, ' ').trim());
}

/**
 * Como chamar o resultado de uma publicacao. Pura.
 *
 * O log dizia "FALHA" quando o produto TINHA sido criado e so faltava a
 * finalizacao (rascunho): quem lia o log ia procurar defeito onde nao havia, e
 * pior, podia mandar publicar de novo e duplicar o produto.
 */
function rotuloDoResultado(r) {
  if (r && r.url) return 'OK';
  if (r && r.hotmartProductId) return 'RASCUNHO';
  return 'FALHA';
}

/** Explicacao curta do resultado, para a mesma linha de log. Pura. */
function detalheDoResultado(r) {
  if (r && r.url) return String(r.url);
  if (r && r.hotmartProductId) return 'produto ' + String(r.hotmartProductId) + ' criado, aguardando finalizacao';
  return umaLinha((r && r.error) || 'sem url', 80);
}

/**
 * A rodada caiu porque a SESSAO morreu no meio (e nao por culpa do livro)?
 *
 * 27/09/2026: a Hotmart deslogou durante o lote 47 e os 18 livros falharam com
 * "eBook card not found ... URL: https://sso.hotmart.com/login". Cada falha
 * gastou uma das TRES tentativas do livro — tres quedas de sessao tirariam da
 * fila, para sempre, livros que nunca tiveram defeito. E insistir nos 17
 * seguintes so gasta uma hora: deslogado, nenhum vai passar. Pura.
 */
function ehQuedaDeSessao(texto) {
  const t = String(texto == null ? '' : texto);
  const paraLogin = new RegExp('sso[.]hotmart[.]com/(login|logout)');
  const semSessao = new RegExp('(nao autenticado|nao autorizado|sessao expirada|HTTP 401)', 'i');
  return paraLogin.test(t) || semSessao.test(t);
}

/**
 * Este `hot-select` do wizard e o de CATEGORIA?
 *
 * 27/09/2026: a Hotmart acrescentou "Em qual pais voce quer vender?" na etapa
 * de informacoes. O robo escolhia "qualquer hot-select que nao seja o de
 * idioma" e passou a abrir o dropdown de PAIS achando que era categoria — o
 * painel ficava aberto como modal, o "Continuar" nao respondia e o lote inteiro
 * falhava com "No product ID after creation". Foram 0 de 18 em dois lotes.
 *
 * A licao e a mesma de antes (quando o campo novo era o idioma): identificar
 * pelo que o campo DIZ SER, nunca por exclusao — campo novo aparece sem aviso.
 * Pura.
 */
function ehSeletorDeCategoria(atributos) {
  const a = atributos || {};
  const texto = [a.placeholder, a.ariaLabel, a.nome, a.name, a.label].filter(Boolean).join(' ').toLowerCase();
  if (!texto) return false;
  const categoria = new RegExp('categor');
  return categoria.test(texto);
}

/**
 * Campo do wizard que o robo NAO deve confundir com categoria. Serve de
 * diagnostico no log: saber qual campo apareceu no lugar. Pura.
 */
function campoDoWizard(atributos) {
  const a = atributos || {};
  const texto = [a.placeholder, a.ariaLabel, a.nome, a.name, a.label].filter(Boolean).join(' ').toLowerCase();
  if (new RegExp('categor').test(texto)) return 'categoria';
  if (new RegExp('idioma|language').test(texto)) return 'idioma';
  if (new RegExp('pais|país|country|vender').test(texto)) return 'pais';
  return 'desconhecido';
}

/**
 * Que botao apertar num modal do wizard. Devolve o texto do botao, ou null
 * quando o modal nao e conhecido (ai nao se clica no escuro).
 *
 * 27/09/2026: o robo batia num modal "Seus dados nao foram salvos — Voce
 * perdera o que ja fez ate aqui. Quer trocar o formato mesmo assim?" e
 * respondia apertando Escape, que nao fecha. O wizard ficava preso, o
 * "Continuar" nao respondia e o lote inteiro morria com "No product ID after
 * creation" (0 de 18, duas vezes). A resposta certa e "Nao, voltar": manter o
 * formato eBook e seguir o cadastro.
 *
 * Confirmar a troca ("Sim, trocar") JOGA FORA o cadastro em andamento — por
 * isso a regra nunca escolhe o botao de confirmar. Pura.
 */
function botaoDoModal(texto) {
  const t = String(texto == null ? '' : texto).toLowerCase();
  if (!t.trim()) return null;
  const perdaDeDados = new RegExp('(nao foram salvos|não foram salvos|perdera|perderá|trocar o formato)');
  if (perdaDeDados.test(t)) {
    // O rotulo muda de lugar; o que importa e recusar a troca.
    const recusa = new RegExp('(nao, voltar|não, voltar|voltar|cancelar)');
    return recusa.test(t) ? 'Não, voltar' : null;
  }
  return null;
}

/**
 * A rodada parou por um problema do AMBIENTE, e nao do livro?
 *
 * 27/09/2026: depois de um login novo, o aviso de cookies voltou e cobriu a
 * faixa do rodape onde fica o "Continuar". Nenhum livro passava, e cada um
 * gastava uma das tres tentativas — em tres rodadas, livros bons sairiam da
 * fila para sempre por causa de um banner. Pura.
 */
function ehBloqueioDeAmbiente(texto) {
  const t = String(texto == null ? '' : texto);
  const coberto = new RegExp('(COBERTO|coberto por|aviso de cookies)', 'i');
  const semId = new RegExp('No product ID after creation', 'i');
  return coberto.test(t) || semId.test(t);
}

/**
 * O clique no botao foi mesmo bloqueado, ou so estava fora da tela?
 *
 * 29/09/2026: a guarda que confere quem esta sob o ponto registrava
 * "Continuar COBERTO por (nada no ponto)" em lotes que publicavam 18/18 — o
 * botao estava apenas fora da area visivel, e `elementFromPoint` devolve nulo
 * nesse caso. Alarme falso e pior que alarme nenhum: ensina a ignorar o aviso
 * que um dia sera verdadeiro (foi um aviso desses que escondeu o banner de
 * cookies cobrindo o botao, dois dias antes).
 *
 * `quem` e o que estava no ponto DEPOIS de rolar: nulo quando nao ha nada
 * (fora da tela), ou a descricao do elemento que esta por cima. Pura.
 */
function motivoDoCliqueBloqueado(quem) {
  const t = String(quem == null ? '' : quem).trim();
  if (!t) return null;                                   // nada por cima: nao ha bloqueio
  if (/^\(/.test(t)) return t;                           // observacao ja formatada
  const brancos = new RegExp('[' + String.fromCharCode(13,10,9) + ']+', 'g');
  return 'coberto por "' + t.replace(brancos, ' ').slice(0, 60) + '"';
}

/**
 * O que o cadastro de produto recebe. Pura.
 *
 * 30/09/2026: o objeto era montado a mao, so com os campos do livro, e o preco
 * do combo (R$ 19,90) ficava para tras — o produto subiu a R$ 4,99. Tudo que o
 * cadastro precisa sai daqui, e o teste cobra que o preco viaja junto.
 * `locais` sao os campos que o fluxo ja tratou (descricao traduzida etc.).
 */
function camposDoCadastro(ebook, locais) {
  const e = ebook || {};
  const l = locais || {};
  return {
    title: l.title != null ? l.title : e.title,
    topic: l.topic != null ? l.topic : e.topic,
    description: l.description != null ? l.description : e.description,
    coverPath: l.coverPath != null ? l.coverPath : e.coverPath,
    pdfPath: l.pdfPath != null ? l.pdfPath : e.pdfPath,
    language: e.language,
    precoLoja: e.precoLoja,
  };
}

/** Preco a digitar: o do combo quando houver, senao o padrao da loja. Pura. */
function precoDoCadastro(ebook, padrao) {
  const p = ebook && ebook.precoLoja;
  return p != null && String(p).trim() ? String(p).trim() : padrao;
}

module.exports = {
  camposDoCadastro, precoDoCadastro,
  ehQuedaDeSessao, motivoDoCliqueBloqueado, ehSeletorDeCategoria, campoDoWizard, botaoDoModal, ehBloqueioDeAmbiente,
  norm, rotuloDoResultado, detalheDoResultado, getCategoryPT, digitosDoPreco, idProdutoDaUrl, TECH_KW, HEALTH_KW, FINANCE_KW, BUSINESS_KW,
  nomeComparavel, mesmoProduto, motivoProdutoErrado, umaLinha, ehAvisoDeTermos, ehBotaoDeAviso,
};
