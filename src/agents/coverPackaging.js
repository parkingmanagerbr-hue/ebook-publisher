'use strict';
/**
 * coverPackaging.js — Packaging VIRAL da capa: ângulo de DOR + promessa.
 *
 * Antes a capa levava o título do e-book, um kicker fixo ("Método Prático") e um
 * badge escolhido por palavra-chave. Isso é embalagem sem ÂNGULO — e o playbook
 * viral do GENIA é explícito: sem ângulo único e contraintuitivo, não produzir.
 * Quem compra não conhece o produto; clica pelo PACKAGING.
 *
 * Aqui o LLM escreve a embalagem a partir da DOR que o tema resolve:
 *   kicker    → a dor, em forma de provocação/pergunta curta
 *   titulo    → a promessa, curta e com hipérbole
 *   subtitulo → como se resolve, concreto
 *   badge     → selo de credibilidade/urgência
 *
 * MELHORIA CONTÍNUA (padrão do viral_text_agent, §3.4.4 do GENIA): a escolha da
 * TÉCNICA de gancho é um bandit epsilon-greedy. Cada capa registra qual técnica
 * usou; quando houver venda atribuída, `pontuarHook` alimenta o placar e as
 * técnicas que vendem passam a ser escolhidas mais. Sem dados, todas empatam e
 * a exploração cuida do resto — não há chute embutido.
 */
const fs = require('fs');
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('coverPackaging'); }
catch { log = { info: console.log, warn: console.warn }; }

const MEMORIA = process.env.COVER_PACKAGING_MEMORY
  || path.join(__dirname, '..', '..', 'data', 'cover_packaging_memory.json');

// Técnicas de gancho. A descrição vai no prompt — o LLM escreve, o bandit escolhe.
const HOOKS = [
  { id: 'dor',             desc: 'Nomeie a dor concreta que a pessoa sente hoje, sem rodeio.' },
  { id: 'pergunta',        desc: 'Pergunta direta que a pessoa responderia sim com vergonha.' },
  { id: 'numero',          desc: 'Prazo ou quantidade especifica e crivel.' },
  { id: 'contraintuitivo', desc: 'Afirmacao que contraria o senso comum sobre o tema.' },
  { id: 'urgencia',        desc: 'O custo de continuar como esta, o que se perde a cada dia.' },
  { id: 'prova_social',    desc: 'O que quem ja resolveu fez de diferente.' },
  { id: 'antes_depois',    desc: 'Contraste entre o estado atual e o desejado.' },
  { id: 'inimigo_comum',   desc: 'Aponte o culpado externo pela dor (mito, industria, habito).' },
];

const EPSILON = parseFloat(process.env.COVER_HOOK_EPSILON || '0.15');

function lerMemoria() {
  try { return JSON.parse(fs.readFileSync(MEMORIA, 'utf8')); }
  catch { return { hooks: {}, log: [] }; }
}

function salvarMemoria(m) {
  try {
    fs.mkdirSync(path.dirname(MEMORIA), { recursive: true });
    fs.writeFileSync(MEMORIA, JSON.stringify(m, null, 2));
  } catch (e) { log.warn('nao consegui salvar memoria: ' + e.message.slice(0, 60)); }
}

/** Média de score da técnica; sem dados retorna 0 (empate). */
function media(h) {
  if (!h || !h.usos) return 0;
  return (h.scoreSum || 0) / h.usos;
}

/**
 * Escolhe a técnica: EPSILON explora ao acaso, o resto explora a melhor.
 * Enquanto ninguém tem score, todas empatam em 0 e o desempate é aleatório —
 * é o comportamento certo para não cristalizar uma escolha sem evidência.
 */
/**
 * Nichos onde a capa nao pode fazer afirmacao causal.
 *
 * "Inimigo comum" e "contraintuitivo" funcionam apontando um culpado ou
 * contrariando o que se sabe — em saude isso vira alegacao medica sem lastro
 * (saiu "SUAS DORES VEM DA INDUSTRIA DE ALIMENTOS" numa capa). E risco de
 * CDC/CONAR e de publicidade enganosa em saude. Nesses nichos as duas tecnicas
 * saem do sorteio; as outras seis continuam.
 */
const TECNICAS_VEDADAS_SAUDE = new Set(['inimigo_comum', 'contraintuitivo']);
const PISTA_SAUDE = /sa[uú]de|dieta|doen[cç]a|dor(es)?\b|inflama|ansiedade|depress|diabet|press[aã]o|colesterol|emagrec|peso|sono|ins[oô]nia|horm[oô]n|gravidez|beb[eê]|m[eé]dic|rem[eé]dio|suplement|terapia|health|diet|pain|disease|anxiety|weight|sleep/i;

function ehNichoSaude(categoria, topico) {
  return categoria === 'saude' || PISTA_SAUDE.test(String(topico || ''));
}

function escolherHook(memoria, categoria, topico) {
  const m = memoria || lerMemoria();
  const disponiveis = ehNichoSaude(categoria, topico)
    ? HOOKS.filter(h => !TECNICAS_VEDADAS_SAUDE.has(h.id))
    : HOOKS;
  if (Math.random() < EPSILON) return disponiveis[Math.floor(Math.random() * disponiveis.length)];
  let melhor = disponiveis[0];
  let melhorScore = -Infinity;
  const embaralhado = disponiveis.slice().sort(() => Math.random() - 0.5); // desempate justo
  for (const h of embaralhado) {
    const s = media(m.hooks[h.id]);
    if (s > melhorScore) { melhorScore = s; melhor = h; }
  }
  return melhor;
}

/** Registra que a técnica foi usada numa capa (para pontuar depois). */
function registrarUso(hookId, contexto) {
  const m = lerMemoria();
  m.hooks[hookId] = m.hooks[hookId] || { usos: 0, scoreSum: 0 };
  m.hooks[hookId].usos++;
  m.log.push(Object.assign({ hookId, quando: new Date().toISOString() }, contexto || {}));
  if (m.log.length > 2000) m.log = m.log.slice(-2000);
  salvarMemoria(m);
}

/** Alimenta o placar quando houver sinal real (venda, clique, conversão). */
function pontuarHook(hookId, score) {
  const m = lerMemoria();
  m.hooks[hookId] = m.hooks[hookId] || { usos: 0, scoreSum: 0 };
  m.hooks[hookId].scoreSum = (m.hooks[hookId].scoreSum || 0) + Number(score || 0);
  salvarMemoria(m);
  return m.hooks[hookId];
}

function placar() {
  const m = lerMemoria();
  return Object.entries(m.hooks)
    .map(function (e) {
      return { id: e[0], usos: e[1].usos, media: Number(media(e[1]).toFixed(3)) };
    })
    .sort(function (a, b) { return b.media - a.media; });
}

/**
 * Corta texto que não cabe no layout, sem cortar palavra pela metade.
 *
 * O limiar de 60% funcionava para frases longas e falhava justamente nos
 * textos curtos: "30 DIAS GARANTIDOS" (18) cortado em 16 caia no meio da
 * palavra porque o ultimo espaco estava em 7 — abaixo de 60% de 16. A capa
 * saiu com "30 DIAS GARANT", verificado a olho. Agora corta no espaco sempre
 * que sobrar pelo menos 40% do limite, e so entao aceita corte seco.
 */
// Conectivos que, no fim de um texto cortado, deixam a frase pela metade. Cortar
// ANTES do ultimo conectivo fecha a oracao: "...como ganhar confianca e evitar
// mal-entendidos" vira "...como ganhar confianca" em vez de "...e evitar". Caso
// real (16/09/2026, capa holandesa): "hoe je vertrouwen wint en misverstanden".
const CONECTIVOS = new Set(['e', 'ou', 'mas', 'com', 'and', 'or', 'but', 'with', 'y', 'o', 'pero', 'con',
  'et', 'ou', 'mais', 'avec', 'und', 'oder', 'aber', 'mit', 'en', 'of', 'maar', 'met', 'i', 'lub', 'oraz', 'ed', 'ma',
  // preposicoes que tambem deixam a frase aberta
  'sem', 'para', 'por', 'em', 'de', 'without', 'for', 'to', 'sin', 'sans', 'pour', 'ohne', 'für', 'zu', 'voor', 'zonder', 'bez', 'dla', 'senza', 'per']);

function limitar(txt, max) {
  const t = String(txt || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const minimo = max * 0.4;
  // 1) antes do ultimo conectivo
  const palavras = corte.split(' ');
  for (let i = palavras.length - 1; i > 0; i--) {
    if (CONECTIVOS.has(palavras[i].toLowerCase())) {
      const antes = palavras.slice(0, i).join(' ').replace(/[,;:\-–—]+$/, '').trim();
      if (antes.length >= minimo) return antes;
      break;
    }
  }
  // 2) na ultima pontuacao de pausa
  const pont = Math.max(corte.lastIndexOf(','), corte.lastIndexOf(';'), corte.lastIndexOf(':'), corte.lastIndexOf(' —'), corte.lastIndexOf(' -'));
  if (pont >= minimo) return corte.slice(0, pont).trim();
  // 3) no ultimo espaco
  const esp = corte.lastIndexOf(' ');
  if (esp >= minimo) return corte.slice(0, esp).trim();
  return corte.trim();
}

/**
 * Gera a embalagem. NUNCA lança: sem IA, devolve null e o chamador mantém o
 * texto atual — capa boa com título comum é melhor que pipeline parado.
 */
// Alegacao causal ou terapeutica, e culpa atribuida a terceiros.
const ALEGACAO = /\bcur(a|ar|e|am)\b|\btrat(a|ar|amento)\b|causa(d[ao])?\b|culpa|v[eê]m d[aoe]|vem d[aoe]|ind[uú]stria|m[eé]dicos? (n[aã]o|mentem|escondem)|elimin(a|e) (a |o )?(dor|doen)|acab(a|e) com (a |o )?(dor|doen)|\bcure\b|\bcauses?\b|\bheals?\b|\bindustry\b/i;

/**
 * Promessa de resultado, credencial ou prova social que o livro nao tem.
 *
 * Numero de PASSOS ou DIAS de um metodo e legitimo ("5 passos", "em 30 dias");
 * percentual de resultado, anos de experiencia, "comprovado", "mais vendido" e
 * contagem de alunos/clientes nao — sao afirmacoes que ninguem pode provar.
 */
const PROMESSA_SEM_LASTRO = new RegExp([
  '\\d+\\s*%', '\\d+\\s*パーセント',
  '実績', '保証', '実証', 'ナンバーワン', '売上\\s*No',
  'certifi', 'oficial', 'aprovad', 'credenciad', 'homologad', 'garantid', 'comprovad',
  'certified', 'official', 'approved', 'guarantee', 'proven',
  'best.?seller', 'mais vendid', 'm[aá]s vendid',
  // Da amostra de capas publicadas em 14/09/2026:
  'sem rem[eé]dio', 'sem medica', 'sin medicament', 'without medication', 'sans m[eé]dicament',
  'controla\\w*\\s+(a\\s+|o\\s+|la\\s+)?(glicose|glucosa|diabetes|press[aã]o|colesterol)',
  'resultados?\\s+em\\s+\\d+', 'resultados?\\s+en\\s+\\d+', 'results?\\s+in\\s+\\d+', 'r[eé]sultats?\\s+en\\s+\\d+',
  'ci[eê]ncia\\s+(pura|real|comprovada)', 'cient[ií]ficamente', 'm[eé]todo testado', 'casos reais',
  'n[ºo°]\\s*1\\b', '#\\s*1\\b', 'n[uú]mero\\s*1\\b', 'number\\s*one', 'n[uú]mero uno',
  'anos de experi', 'a[nñ]os de experiencia', 'years of experience', "ans d.exp",
  '\\d+\\s*mil\\s+(alunos|clientes|vendas|pessoas|leitores)', 'thousands of (students|customers|readers)',
].join('|'), 'i');

async function revisar(p, idioma) {
  try {
    const { generate } = require('../core/aiClient');
    const pedido = [
      'Revise ortografia, acentuacao e concordancia do texto de capa abaixo, no idioma ' + idioma + '.',
      'Nao mude o sentido, nao acrescente palavras, respeite o tamanho de cada campo.',
      'Se ja estiver correto, devolva igual.',
      '',
      JSON.stringify({ kicker: p.kicker, titulo: p.titulo, subtitulo: p.subtitulo, badge: p.badge }),
      '',
      'Responda APENAS com o JSON revisado, mesmas chaves.',
    ].join('\n');
    const bruto = await generate(pedido, 'Voce e um revisor de texto rigoroso.', { maxTokens: 600 });
    const t = typeof bruto === 'string' ? bruto : (bruto && bruto.text) || '';
    const mm = t.match(/\{[\s\S]*\}/);
    if (!mm) return p;
    const r = JSON.parse(mm[0]);
    // So aceita a revisao se ela devolveu os mesmos campos preenchidos; revisor
    // que apaga campo estragaria uma embalagem que estava boa.
    if (!r.kicker || !r.titulo || !r.subtitulo) return p;
    return { kicker: r.kicker, titulo: r.titulo, subtitulo: r.subtitulo, badge: r.badge || p.badge };
  } catch (e) {
    log.warn('revisao indisponivel, mantendo original: ' + String(e.message).slice(0, 60));
    return p;
  }
}

async function gerarPackaging(opts) {
  const o = opts || {};
  const hook = escolherHook(undefined, o.categoria, o.topico || o.titulo);
  try {
    const { generate } = require('../core/aiClient');

    const prompt = [
      'Tema do e-book: "' + (o.topico || o.titulo) + '" (categoria: ' + (o.categoria || 'geral') + ').',
      'Idioma da capa: ' + (o.idioma || 'pt-BR') + '.',
      '',
      'TECNICA DE GANCHO a usar: ' + hook.desc,
      '',
      'Escreva a EMBALAGEM da capa, mirando a DOR de quem compraria:',
      '- kicker: a dor, ate 40 caracteres, CAIXA ALTA, sem ponto final.',
      '- titulo: a promessa, ate 28 caracteres, no maximo 4 palavras, impacto alto.',
      '- subtitulo: como se resolve, ate 60 caracteres, concreto e especifico.',
      '',
      'Regras: nada generico (nao use "guia completo" nem "metodo pratico");',
      'sem aspas; sem promessa de ganho financeiro garantido nem de cura;',
      'NUNCA afirme causa de doenca, dor ou sintoma, nem que algo cura ou trata;',
      'NUNCA culpe industria, empresa, profissao ou grupo de pessoas;',
      'sem superlativo sem prova ("o melhor", "numero 1", "definitivo");',
      'badge NUNCA sugere certificacao, selo oficial, aprovacao ou garantia;',
      'use apenas palavras que existem no dicionario do idioma — nada de neologismo;',
      'NUNCA percentual de resultado, anos de experiencia, "comprovado", "mais vendido" nem numero de alunos/clientes;',
      'em japones, escreva com kanji e hiragana naturais — katakana so para palavra estrangeira;',
      'ortografia e concordancia impecaveis no idioma pedido;',
      'linguagem simples, de quem fala com a pessoa que sente a dor.',
      '',
      'Responda APENAS com JSON: {"kicker":"...","titulo":"...","subtitulo":"...","badge":"..."}',
    ].join('\n');

    // Teto pequeno: o gancho tem ~50 tokens, e o Groq desconta o max_tokens
    // pedido do limite por minuto. Folga para modelo de raciocinio (gpt-oss).
    const bruto = await generate(prompt, 'Voce e um diretor de arte especialista em capas que vendem.', { maxTokens: 1200 });
    const texto = typeof bruto === 'string' ? bruto : (bruto && bruto.text) || '';

    // Modelo sem structured output embrulha em markdown — extrair o objeto.
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) {
      // Mostra o que voltou: sem isso "nao devolveu JSON" nao separa resposta
      // vazia (raciocinio comeu o teto) de texto solto ou recusa.
      const prov = bruto && typeof bruto === 'object' ? bruto.provider : '?';
      log.warn('IA nao devolveu JSON de packaging [' + prov + ']: ' + JSON.stringify(String(texto).slice(0, 120)));
      return null;
    }

    let p;
    try { p = JSON.parse(m[0]); } catch (e) { log.warn('JSON de packaging invalido'); return null; }

    // REVISAO: segunda chamada curta, so sobre as quatro frases. Os modelos
    // menores (os que sobram quando o Gemini esgota) erram na capa publica —
    // sairam "MITOS" com acento, "VEM" no lugar de "vem" plural, e "FALTA
    // CLIENTES". Custa pouco: entrada de ~60 palavras e teto de 600 tokens,
    // contra os 1200 da geracao. Se a revisao falhar, fica o texto original —
    // nao vale perder a capa por causa dela.
    p = await revisar(p, o.idioma || 'pt-BR');

    // NFKC antes dos filtros: em japones o modelo escreve digito e simbolo em
    // largura cheia ("１０％削減"), que o \d e o % dos regex nao reconhecem —
    // assim passou uma promessa de 10% numa capa em 14/09/2026. Normalizar
    // tambem uniformiza o que vai para a capa.
    for (const k of ['kicker', 'titulo', 'subtitulo', 'badge']) {
      if (typeof p[k] === 'string') p[k] = p[k].normalize('NFKC');
    }

    // Filtro local de alegacao: a instrucao no prompt reduz, mas nao garante.
    // Em nicho de saude, qualquer frase que afirme causa, cura ou culpado
    // derruba a embalagem inteira — melhor capa sem gancho que capa com
    // alegacao medica. A capa volta para a fila e tenta de novo depois.
    if (ehNichoSaude(o.categoria, o.topico || o.titulo)) {
      const junto = [p.kicker, p.titulo, p.subtitulo, p.badge].join(' ');
      if (ALEGACAO.test(junto)) {
        log.warn('packaging recusado por alegacao em nicho de saude: "' + junto.slice(0, 80) + '"');
        return null;
      }
    }

    // Promessa sem lastro. Em 14/09/2026 sairam "CERTIFICADO" num selo, e numa
    // capa japonesa "実績 10年" (10 anos de experiencia) e "reduza o desperdicio em
    // 30%" — nada disso existe. Selo com promessa e so zerado (cai no rotulo
    // neutro); promessa no titulo, kicker ou subtitulo derruba a embalagem e a
    // capa volta para a fila, porque ali nao da para apagar sem mudar o sentido.
    if (PROMESSA_SEM_LASTRO.test(String(p.badge || ''))) p.badge = '';
    const corpoCapa = [p.kicker, p.titulo, p.subtitulo].join(' ');
    if (PROMESSA_SEM_LASTRO.test(corpoCapa)) {
      log.warn('packaging recusado por promessa sem lastro: "' + corpoCapa.slice(0, 80) + '"');
      return null;
    }
    const out = {
      kicker: limitar(p.kicker, 40).toUpperCase(),
      titulo: limitar(p.titulo, 28),
      subtitulo: limitar(p.subtitulo, 60),
      // O selo NAO vem mais da IA. O prompt pedia um "selo curto de
      // credibilidade" — e um modelo sem credencial nenhuma inventava:
      // amostra de 12 capas publicadas em 14/09/2026 trouxe CIENCIA PURA,
      // APROVACAO, METODO TESTADO, APROVADO POR, CERTIFIE 2024, ESPECIALISTA,
      // CASOS REAIS. Vazio aqui faz o gerador usar o rotulo neutro traduzido
      // ("Passo a Passo", "Guia 2026"), que nao afirma nada.
      badge: '',
      hookId: hook.id,
    };
    // Embalagem incompleta é pior que a atual: melhor recusar inteira.
    if (!out.kicker || !out.titulo || !out.subtitulo) {
      log.warn('packaging incompleto — mantendo texto padrao');
      return null;
    }
    registrarUso(hook.id, { topico: String(o.topico || o.titulo || '').slice(0, 80), titulo: out.titulo });
    log.info('packaging [' + hook.id + ']: "' + out.kicker + '" / "' + out.titulo + '"');
    return out;
  } catch (e) {
    log.warn('packaging falhou (nao critico): ' + e.message.slice(0, 100));
    return null;
  }
}

module.exports = { gerarPackaging, escolherHook, registrarUso, pontuarHook, placar, HOOKS, limitar, ehNichoSaude, ALEGACAO, TECNICAS_VEDADAS_SAUDE, PROMESSA_SEM_LASTRO };
