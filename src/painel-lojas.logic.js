'use strict';
/**
 * painel-lojas.logic.js — REGRA PURA do bloco "Livros por loja" do painel.
 *
 * Recebe a contagem JÁ MEDIDA de livros com id em cada loja e devolve as linhas
 * ordenadas, rotuladas e com o estado da loja. O `getStats` antigo só contava
 * hotmart/cakto/amazon; aqui entram TAMBÉM kiwify e gplay (as "novas lojas").
 *
 * Decisões que viram negócio (e por isso ficam aqui, testadas):
 *
 * - Loja ATIVA (hotmart/cakto/kiwify) aparece SEMPRE que a coluna existe, mesmo
 *   com 0 — 0 numa loja ativa é sinal (parou de publicar), não ruído.
 * - Loja PAUSADA de propósito (amazon = conta/banco; gplay = em revisão) só
 *   aparece se já tem livro lá (>0), com a tarja do porquê. Mostrar loja pausada
 *   zerada seria alarme diário de algo decidido.
 * - Coluna que NÃO existe no banco (contagem undefined) é OMITIDA — "não medi"
 *   não é "tem zero". Fabricar 0 para coluna ausente é inventar dado.
 * - Ativas vêm antes das pausadas; dentro de cada grupo, maior contagem primeiro.
 */

// Lojas que deveriam estar vendendo, e o porquê de cada pausa.
const LOJAS = {
  hotmart: { rotulo: 'Hotmart', estado: 'ativa' },
  cakto:   { rotulo: 'Cakto',   estado: 'ativa' },
  kiwify:  { rotulo: 'Kiwify',  estado: 'ativa' },
  amazon:  { rotulo: 'Amazon KDP', estado: 'pausada', motivo: 'conta/banco' },
  gplay:   { rotulo: 'Google Play', estado: 'pausada', motivo: 'em revisão' },
};
const ORDEM_ESTADO = { ativa: 0, pausada: 1 };

/**
 * @param {Record<string, number|undefined>} contagens  livros com id por loja.
 *        undefined = coluna inexistente (não medida); número = contagem real.
 * @param {number} [totalLivros]  total de livros gerados, para o % de cobertura.
 * @returns {{loja:string, rotulo:string, n:number, estado:string,
 *            motivo?:string, pct:number|null}[]}
 */
function resumoLojas(contagens, totalLivros) {
  const c = contagens || {};
  const total = Number(totalLivros) || 0;
  const linhas = [];
  for (const loja of Object.keys(LOJAS)) {
    const n = c[loja];
    if (n == null) continue;                 // coluna ausente: não inventa 0.
    const meta = LOJAS[loja];
    if (meta.estado === 'pausada' && n <= 0) continue; // pausada zerada não entra.
    const linha = {
      loja,
      rotulo: meta.rotulo,
      n,
      estado: meta.estado,
      pct: total > 0 ? Math.round((n / total) * 1000) / 10 : null,
    };
    if (meta.motivo) linha.motivo = meta.motivo;
    linhas.push(linha);
  }
  linhas.sort((a, b) =>
    (ORDEM_ESTADO[a.estado] - ORDEM_ESTADO[b.estado]) || (b.n - a.n));
  return linhas;
}

module.exports = { resumoLojas, LOJAS };
