'use strict';
/**
 * especificacao.js — o que uma ferramenta de livro contem, e a porta que a
 * resposta da IA tem de atravessar para virar ferramenta.
 *
 * Contexto (30/09/2026): piloto de "livro + ferramenta" com os 20 livros em
 * destaque, vendido em combo e acessado pela area de membros da loja. A IA le o
 * livro UMA vez e propoe o plano de acao; o codigo confere tudo e so aceita o
 * que tem forma de ferramenta. A pagina que o comprador usa nao chama IA nunca.
 *
 * Regras que protegem o comprador:
 *   - nada de promessa de resultado nem numero inventado ("em 30 dias voce vai
 *     faturar X"): risco de CDC/CONAR e o livro nao sustenta;
 *   - nada que fale da propria ferramenta como feita por IA (pedido do dono);
 *   - livro de saude, dinheiro ou direito leva o aviso de que nao substitui o
 *     profissional — o comprador vai AGIR com base nesta pagina.
 *
 * Tudo puro.
 */

const LIMITES = {
  capitulosMin: 3, capitulosMax: 12,
  acoesMin: 2, acoesMax: 6,
  habitosMax: 7,
  titulo: 120, resumo: 280, acao: 160, habito: 120,
};

/** Frases que o comprador nao pode ler numa ferramenta de livro. */
const PROIBIDO = [
  /\b(como (uma|um) (ia|intelig[eê]ncia artificial|modelo de linguagem))\b/i,
  /\bgerad[oa] (por|com) (ia|intelig[eê]ncia artificial)\b/i,
  /\b(garantid[oa]|garantimos|garante que)\b/i,
  /\b(resultado[s]? (garantido|certo)s?|100% (eficaz|garantido))\b/i,
  /\b(fature|lucre|ganhe) (at[eé] )?r?\$ ?\d/i,
];

/** Assuntos em que a pagina leva aviso de "nao substitui o profissional". */
const AREA_SENSIVEL = [
  [/sa[uú]de|dieta|nutri|low[- ]?carb|m[eé]dic|doen[çc]|sintom|gravidez|beb[eê]|terapia|ansiedade|sono|exerc[ií]cio|emagrec/i, 'saude'],
  [/finan|d[ií]vida|fundo de emerg|poupan|econom|invest|aposentad|imposto|tribut|cr[eé]dito|dinheiro|renda|or[çc]amento|previd/i, 'financas'],
  [/direit|jur[ií]dic|lei\b|contrato|trabalhist|ado[çc][aã]o|document|lgpd|prote[çc][aã]o de dados/i, 'direito'],
];

const AVISOS = {
  saude: 'Este plano organiza o que o livro ensina e não substitui a orientação de um profissional de saúde.',
  financas: 'Este plano organiza o que o livro ensina e não é recomendação individual de investimento ou crédito.',
  direito: 'Este plano organiza o que o livro ensina e não substitui a orientação de um advogado.',
};

/** Uma linha, sem espaço duplo e sem caractere de controle. */
function limpar(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Em que área sensível o livro cai (ou null). Olha título e tema. Pura. */
function areaSensivel(livro) {
  const l = livro || {};
  const texto = [l.title, l.titulo, l.subtitle, l.topic].filter(Boolean).join(' ');
  for (const [re, area] of AREA_SENSIVEL) if (re.test(texto)) return area;
  return null;
}

/**
 * Amostra do livro que cabe no pedido E cobre o livro todo. Pura.
 *
 * 30/09/2026: o primeiro teste mandava os primeiros 12 mil caracteres — o
 * sumário e os dois primeiros capítulos — e o plano saiu com 3 capítulos de um
 * livro de 7. O começo fica (é onde está o sumário); o resto do orçamento vira
 * janelas espalhadas por igual até o fim.
 */
function amostraDoLivro(texto, max = 24000, janelas = 8) {
  const t = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cabeca = Math.floor(max * 0.3);
  const resto = t.slice(cabeca);
  const n = Math.max(1, janelas);
  const tamanho = Math.floor((max - cabeca) / n);
  const passo = Math.floor(resto.length / n);
  const partes = [t.slice(0, cabeca)];
  for (let i = 0; i < n; i++) partes.push(resto.slice(i * passo, i * passo + tamanho));
  return partes.join(' […] ');
}

/**
 * O pedido para a IA: sumário, trechos do livro inteiro e as regras. Pura.
 */
function montarPedido(livro, textoDoLivro, { maxTexto = 24000 } = {}) {
  const l = livro || {};
  const titulo = limpar(l.title || l.titulo, 200);
  const texto = amostraDoLivro(textoDoLivro, maxTexto);
  return [
    'Você recebe o texto de um livro prático e devolve o PLANO DE AÇÃO dele, em JSON, no idioma do livro.',
    'Regras:',
    '- Use SOMENTE o que está no livro. Não invente números, prazos, resultados nem promessas.',
    '- Um bloco do plano para CADA capítulo do sumário do livro, na mesma ordem (o texto abaixo traz trechos do livro inteiro).',
    '- Cada ação é um passo concreto que o leitor consegue marcar como feito ("Listar as despesas fixas do mês").',
    '- Não fale de você, de IA nem de como o plano foi feito.',
    '- Formato EXATO, sem texto fora do JSON:',
    '{"capitulos":[{"titulo":"...","resumo":"uma frase","acoes":["...","..."]}],"habitos":["..."]}',
    '- De ' + LIMITES.capitulosMin + ' a ' + LIMITES.capitulosMax + ' capítulos; de ' + LIMITES.acoesMin + ' a ' +
      LIMITES.acoesMax + ' ações por capítulo; até ' + LIMITES.habitosMax + ' hábitos semanais curtos.',
    '',
    'Título do livro: ' + titulo,
    'Texto do livro:',
    texto,
  ].join('\n');
}

/** Tira o JSON de dentro da resposta (cercas de código, texto antes/depois). */
function extrairJson(resposta) {
  const t = String(resposta == null ? '' : resposta);
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(t.slice(ini, fim + 1)); } catch (_) { return null; }
}

function proibido(texto) {
  return PROIBIDO.find(r => r.test(texto)) || null;
}

/**
 * Confere e normaliza a resposta da IA. Devolve { ok, especificacao, motivos }.
 * Linha que viola regra de conteúdo DERRUBA a ferramenta inteira — ação
 * prometendo resultado não é consertável cortando a frase. Pura.
 */
function lerEspecificacao(resposta, livro) {
  const motivos = [];
  const bruto = extrairJson(resposta);
  if (!bruto || typeof bruto !== 'object') return { ok: false, especificacao: null, motivos: ['resposta sem JSON legível'] };

  const caps = Array.isArray(bruto.capitulos) ? bruto.capitulos : [];
  const capitulos = [];
  for (const c of caps) {
    if (!c || typeof c !== 'object') continue;
    const titulo = limpar(c.titulo, LIMITES.titulo);
    const resumo = limpar(c.resumo, LIMITES.resumo);
    const acoes = (Array.isArray(c.acoes) ? c.acoes : [])
      .map(a => limpar(a, LIMITES.acao)).filter(a => a.length >= 5).slice(0, LIMITES.acoesMax);
    if (titulo.length < 3 || acoes.length < LIMITES.acoesMin) continue;
    capitulos.push({ titulo, resumo, acoes });
  }
  if (capitulos.length < LIMITES.capitulosMin) motivos.push('capítulos válidos: ' + capitulos.length + ' (mínimo ' + LIMITES.capitulosMin + ')');

  const habitos = (Array.isArray(bruto.habitos) ? bruto.habitos : [])
    .map(h => limpar(h, LIMITES.habito)).filter(h => h.length >= 5).slice(0, LIMITES.habitosMax);

  const todoTexto = capitulos.flatMap(c => [c.titulo, c.resumo, ...c.acoes]).concat(habitos);
  for (const t of todoTexto) {
    const r = proibido(t);
    if (r) { motivos.push('conteúdo proibido: "' + t.slice(0, 60) + '"'); break; }
  }

  if (motivos.length) return { ok: false, especificacao: null, motivos };
  const l = livro || {};
  const area = areaSensivel(l);
  return {
    ok: true,
    motivos: [],
    especificacao: {
      titulo: limpar(l.title || l.titulo, 200),
      subtitulo: limpar(l.subtitle || l.subtitulo, 240),
      idioma: limpar(l.language || l.idioma || 'pt-BR', 10),
      capitulos: capitulos.slice(0, LIMITES.capitulosMax),
      habitos,
      aviso: area ? AVISOS[area] : null,
    },
  };
}

/** Quantas ações a ferramenta tem (para o log e para a página). Pura. */
function totalDeAcoes(esp) {
  return ((esp && esp.capitulos) || []).reduce((n, c) => n + ((c && c.acoes) || []).length, 0);
}

module.exports = { amostraDoLivro, montarPedido, lerEspecificacao, extrairJson, areaSensivel, totalDeAcoes, LIMITES, AVISOS, limpar };
