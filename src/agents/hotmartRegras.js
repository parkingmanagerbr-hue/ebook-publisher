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

module.exports = {
  norm, rotuloDoResultado, detalheDoResultado, getCategoryPT, digitosDoPreco, idProdutoDaUrl, TECH_KW, HEALTH_KW, FINANCE_KW, BUSINESS_KW,
  nomeComparavel, mesmoProduto, motivoProdutoErrado, umaLinha, ehAvisoDeTermos, ehBotaoDeAviso,
};
