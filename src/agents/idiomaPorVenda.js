'use strict';
/**
 * idiomaPorVenda.js — escolhe o idioma do proximo e-book pelo que VENDE.
 *
 * A rotacao era circular: cada idioma recebia a mesma fatia, independente do
 * resultado. Em 14/09/2026 o catalogo tinha 717 livros em pt-BR com 2 vendas e
 * 19 em japones com 2 vendas — conversao por produto ~30x maior — e o gerador
 * continuava produzindo em portugues.
 *
 * Amostragem de Thompson com Beta(a + vendas, b + produtos - vendas):
 * - idioma que converte melhor e sorteado mais vezes;
 * - idioma sem venda nenhuma continua sendo sorteado de vez em quando (a
 *   incerteza e grande com poucos produtos), entao o sistema nao para de
 *   explorar por causa de uma amostra pequena;
 * - o prior (b grande) impede que 1 venda em 2 produtos vire "50% de conversao".
 *
 * Atribuicao: a venda liga ao e-book pelo id do produto. Venda de produto que
 * nao esta no banco (duplicata criada por fora, caso real do livro japones)
 * liga pelo TITULO — sem isso as duas vendas japonesas do dia nao contavam.
 */

const PRIOR_A = 1;
const PRIOR_B = 150; // ~0,7% de conversao a priori: perto do observado no pt-BR

// Normaliza o codigo: o banco tem "ja-JP", a env tem "ja".
const base = l => String(l || '').toLowerCase().split('-')[0];

function estatisticasPorIdioma(db) {
  const produtos = db.prepare(
    "SELECT language, COUNT(*) AS n FROM ebooks WHERE hotmart_product_id IS NOT NULL AND hotmart_product_id <> '' GROUP BY language"
  ).all();
  let vendas = [];
  // Sem venda de rajada: o "japones vende" de 14/09 era um robo testando cartao
  // (ver sincronizarVendas.marcarSuspeitas). Banco antigo sem a coluna usa tudo.
  let temSuspeita = false;
  try { temSuspeita = db.prepare('PRAGMA table_info(vendas_hotmart)').all().some(c => c.name === 'suspeita'); } catch { /* sem tabela */ }
  try {
    vendas = db.prepare(
      'SELECT COALESCE(e1.language, e2.language) AS language, COUNT(*) AS v ' +
      'FROM (SELECT * FROM vendas_hotmart' + (temSuspeita ? ' WHERE suspeita = 0' : '') + ') vh ' +
      'LEFT JOIN ebooks e1 ON CAST(e1.hotmart_product_id AS TEXT) = CAST(vh.produto_id AS TEXT) ' +
      'LEFT JOIN ebooks e2 ON e1.id IS NULL AND e2.id = (SELECT id FROM ebooks WHERE title = vh.produto LIMIT 1) ' +
      'GROUP BY 1'
    ).all();
  } catch { /* tabela ainda nao criada: sem venda, so exploracao */ }

  const est = {};
  for (const p of produtos) {
    const k = base(p.language);
    est[k] = est[k] || { produtos: 0, vendas: 0 };
    est[k].produtos += p.n;
  }
  for (const v of vendas) {
    if (!v.language) continue;
    const k = base(v.language);
    est[k] = est[k] || { produtos: 0, vendas: 0 };
    est[k].vendas += v.v;
  }
  return est;
}

// Gamma por Marsaglia-Tsang (shape >= 1) e Beta pela razao de Gammas.
function gamma(shape, rnd) {
  if (shape < 1) return gamma(shape + 1, rnd) * Math.pow(rnd(), 1 / shape);
  for (;;) {
    let x, v;
    do {
      const u1 = rnd(), u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
      v = 1 + x / Math.sqrt(9 * shape) - 1 / (9 * shape);
    } while (v <= 0);
    const y = shape * v * v * v;
    const u = rnd();
    // Com y = shape*v^3 a razao alvo/proposta leva v^(3*shape-1) (o jacobiano da
    // troca soma v^2). O expoente era 3*shape-3 e o amostrador saia enviesado:
    // Gamma(1) com media 0,84 e variancia 0,64, Beta(1,150) 16% abaixo do real.
    if (Math.log(u || 1e-12) < 0.5 * x * x + shape - y + (3 * shape - 1) * Math.log(v)) return y;
  }
}
function beta(a, b, rnd) {
  const x = gamma(a, rnd), y = gamma(b, rnd);
  return x / (x + y);
}

/**
 * @param {string[]} idiomas  candidatos (da env EBOOK_LANGUAGES)
 * @param {object}   est      saida de estatisticasPorIdioma
 * @param {function} rnd      gerador aleatorio (injetavel no teste)
 */
// Parte dos ciclos sorteia idioma uniforme, ignorando as vendas. Com a amostra
// de 14/09 (2 vendas japonesas, possivelmente do mesmo comprador nos produtos
// duplicados) o Thompson puro dava 64% dos livros em japones — reacao grande
// demais para tao pouco dado. Com 35% uniforme o japones fica perto de metade e
// todo idioma segue recebendo livro enquanto a evidencia se acumula.
const EXPLORACAO = parseFloat(process.env.IDIOMA_EXPLORACAO || '0.35');

function escolherIdioma(idiomas, est, rnd = Math.random) {
  if (rnd() < EXPLORACAO) return idiomas[Math.floor(rnd() * idiomas.length) % idiomas.length];
  let melhor = idiomas[0], melhorAmostra = -1;
  for (const l of idiomas) {
    const s = est[base(l)] || { produtos: 0, vendas: 0 };
    const falhas = Math.max(0, s.produtos - s.vendas);
    const amostra = beta(PRIOR_A + s.vendas, PRIOR_B + falhas, rnd);
    if (amostra > melhorAmostra) { melhorAmostra = amostra; melhor = l; }
  }
  return melhor;
}

module.exports = { estatisticasPorIdioma, escolherIdioma, base, PRIOR_A, PRIOR_B, gamma, beta };
