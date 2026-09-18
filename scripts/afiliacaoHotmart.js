'use strict';
/**
 * afiliacaoHotmart.js — abre o programa de afiliados do catalogo e escolhe os
 * livros em destaque.
 *
 * Por que: em 16/09/2026 nenhum produto tinha afiliacao aberta
 * (affiliationType NO_ONE, comissao 0). Sem trafego proprio e sem afiliados, o
 * catalogo so recebia o robo de teste de cartao. Decisao do dono: afiliacao em
 * todo o catalogo e foco em poucos livros bons.
 *
 * - Todos os produtos COM arquivo confirmado: afiliacao de 1 clique, 50%.
 * - DESTAQUES (20): 70%, para aparecerem melhor para os afiliados.
 * - Produto sem arquivo (tabela hotmart_sem_arquivo) fica de fora: afiliado
 *   venderia algo que nao entrega.
 *
 * A chamada e a mesma do assistente do painel (POST /v1/easy-setup), capturada
 * em 16/09/2026 e aceita com o Bearer do servidor. Uma por vez, com pausa.
 *
 * Uso (no container):
 *   node scripts/afiliacaoHotmart.js --destaques        # so lista os 20
 *   node scripts/afiliacaoHotmart.js --aplicar --limite=100
 */
const fs = require('fs');

const COMISSAO_PADRAO = 50;
const COMISSAO_DESTAQUE = 70;
const N_DESTAQUES = 20;
const PAUSA_MS = parseInt(process.env.AFIL_PAUSA_MS || '1200', 10);

// Temas de demanda perene no Brasil e sem risco de alegacao de saude.
const CATEGORIA_PESO = { 'Negocios e Carreira': 3, 'Tecnologia e Programacao': 2, 'Desenvolvimento Pessoal': 1, 'Saude e Esportes': -99 };

// Destaque vai para afiliado anunciar: tema de corpo e mente fica fora mesmo
// quando o classificador de categoria nao pega ("Cuidados com a Pele para
// Adolescentes" entrou na primeira lista de 16/09/2026).
const SAUDE_EXTRA = /pele|acne|skin|dermat|emagre|dieta|suplement|ansiedad|depress|insônia|insonia|sono|horm[oô]n|gravidez|menopausa/i;

/**
 * Nota de um livro para virar destaque. Pura.
 * Prioriza venda real (nao suspeita), portugues, capa viral nova e tema perene;
 * saude fica de fora (risco de alegacao em anuncio de afiliado).
 */
function nota(e, { categoria, saude }) {
  if (saude || categoria === 'Saude e Esportes') return -Infinity;
  if (!String(e.language || '').toLowerCase().startsWith('pt')) return -Infinity;
  let n = 0;
  n += 10 * (Number(e.vendas_reais) || 0);
  n += e.capa_viral ? 4 : 0;
  n += CATEGORIA_PESO[categoria] || 0;
  n += (Number(e.ordem) || 0) / 1e6; // desempate: o mais recente
  return n;
}

function selecionarDestaques(livros, classificar, n = N_DESTAQUES) {
  return livros
    .map(e => ({ e, n: nota(e, classificar(e)) }))
    .filter(x => Number.isFinite(x.n))
    .sort((a, b) => b.n - a.n)
    .slice(0, n)
    .map(x => x.e.produto);
}

/** O que gravar no produto, ou null se ja esta assim. Pura. */
function planejar(atual, destaque) {
  const comissao = destaque ? COMISSAO_DESTAQUE : COMISSAO_PADRAO;
  if (atual && atual.affiliationType === 'ANYONE' && Number(atual.commission) === comissao) return null;
  return { affiliationType: 'ANYONE', commission: comissao };
}

function texto(comissao) {
  return [
    'E-book digital com entrega imediata pela Hotmart, de preço acessível e compra por impulso.',
    '',
    'Por que promover:',
    '- Comissão de ' + comissao + '% em cada venda aprovada.',
    '- Afiliação de 1 clique, sem espera por aprovação.',
    '- Produto de ticket baixo, fácil de indicar em redes sociais, grupos e listas de e-mail.',
    '- Capa profissional e descrição completa na página do produto, prontas para divulgação.',
    '- Material e lista de livros em destaque: veloxisit.com.br/livros/afiliados/',
    '',
    'Regras: não use promessas de resultado garantido, números inventados ou spam. Divulgue de forma honesta, mostrando o que o leitor encontra no e-book.',
    '',
    'Dúvidas: responda pelo e-mail de suporte ao afiliado.',
  ].join('\n');
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const limite = parseInt((process.argv.find(a => a.startsWith('--limite=')) || '--limite=100').split('=')[1], 10);
  const db = require('../src/core/database').getDb();
  const { getCategoryPT } = require('../src/agents/hotmartRegras');
  const { ehNichoSaude } = require('../src/agents/coverPackaging');

  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
  db.prepare('CREATE TABLE IF NOT EXISTS cover_viral_v2 (ebook_id TEXT PRIMARY KEY, quando INTEGER NOT NULL)').run();
  db.prepare('CREATE TABLE IF NOT EXISTS afiliacao_hotmart (produto TEXT PRIMARY KEY, comissao INTEGER, destaque INTEGER, resultado TEXT, quando INTEGER)').run();
  let temVendas = true;
  try { db.prepare('SELECT 1 FROM vendas_hotmart LIMIT 1').all(); } catch { temVendas = false; }

  const livros = db.prepare(
    "SELECT CAST(e.hotmart_product_id AS TEXT) AS produto, e.title, e.topic, e.language, e.rowid AS ordem, " +
    '(SELECT 1 FROM cover_viral_v2 v WHERE v.ebook_id = e.id) AS capa_viral, ' +
    (temVendas ? "(SELECT COUNT(*) FROM vendas_hotmart vh WHERE CAST(vh.produto_id AS TEXT) = CAST(e.hotmart_product_id AS TEXT) AND COALESCE(vh.suspeita,0) = 0) AS vendas_reais " : '0 AS vendas_reais ') +
    "FROM ebooks e WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
    'AND CAST(e.hotmart_product_id AS TEXT) NOT IN (SELECT produto FROM hotmart_sem_arquivo)'
  ).all();
  const classificar = e => {
    const categoria = getCategoryPT(e.title, e.topic);
    const t = (e.title || '') + ' ' + (e.topic || '');
    return { categoria, saude: ehNichoSaude(categoria === 'Saude e Esportes' ? 'saude' : '', t) || SAUDE_EXTRA.test(t) };
  };
  const destaques = new Set(selecionarDestaques(livros, classificar));
  console.log('elegiveis:', livros.length, '| destaques:', destaques.size);
  if (!aplicar) {
    for (const e of livros.filter(x => destaques.has(x.produto))) console.log('  DESTAQUE #' + e.produto + ' ' + e.title.slice(0, 70));
    return;
  }

  const tok = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' };
  const feitos = new Set(db.prepare("SELECT produto FROM afiliacao_hotmart WHERE resultado = 'ok'").all().map(r => r.produto));
  // Destaques primeiro: sao os que mais importam se o lote parar no meio.
  const fila = livros.filter(e => !feitos.has(e.produto)).sort((a, b) => destaques.has(b.produto) - destaques.has(a.produto)).slice(0, limite);
  const marca = db.prepare('INSERT OR REPLACE INTO afiliacao_hotmart VALUES (?,?,?,?,?)');
  const cont = {};
  for (const e of fila) {
    const destaque = destaques.has(e.produto);
    try {
      // Leitura com status conferido: com o token vencendo (16/09/2026, 14:05)
      // a API devolveu erro sem affiliationProgram e 53 produtos viraram
      // "Cannot read properties of undefined" em vez de parar o lote.
      const rg = await fetch('https://api-affiliation.hotmart.com/v1/easy-setup/settings/' + e.produto, { headers: H });
      if (!rg.ok) throw new Error('HTTP ' + rg.status + ' na leitura');
      const g = await rg.json();
      if (!g || !g.affiliationProgram) throw new Error('leitura sem affiliationProgram');
      const mudar = planejar(g.affiliationProgram, destaque);
      if (mudar) {
        const corpo = { program: { productId: Number(e.produto), affiliationType: mudar.affiliationType, affiliateSupportEmail: g.affiliationProgram.supportAffiliateEmail || 'mrovariz@gmail.com', information: texto(mudar.commission), commission: mudar.commission } };
        const r = await fetch('https://api-affiliation.hotmart.com/v1/easy-setup', { method: 'POST', headers: H, body: JSON.stringify(corpo) });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
        const d = (await (await fetch('https://api-affiliation.hotmart.com/v1/easy-setup/settings/' + e.produto, { headers: H })).json()).affiliationProgram;
        if (d.affiliationType !== 'ANYONE' || Number(d.commission) !== mudar.commission) throw new Error('nao persistiu: ' + d.affiliationType + ' ' + d.commission);
      }
      marca.run(e.produto, destaque ? COMISSAO_DESTAQUE : COMISSAO_PADRAO, destaque ? 1 : 0, 'ok', Date.now());
      cont.ok = (cont.ok || 0) + 1;
    } catch (err) {
      marca.run(e.produto, null, destaque ? 1 : 0, 'erro: ' + String(err.message).slice(0, 100), Date.now());
      cont.erro = (cont.erro || 0) + 1;
      if (/HTTP 401|HTTP 403/.test(err.message)) { console.log('token recusado — parando'); break; }
    }
    await new Promise(r => setTimeout(r, PAUSA_MS));
  }
  console.log(JSON.stringify({ fila: fila.length, ...cont }));
}

module.exports = { nota, selecionarDestaques, planejar, texto, SAUDE_EXTRA, COMISSAO_PADRAO, COMISSAO_DESTAQUE };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
