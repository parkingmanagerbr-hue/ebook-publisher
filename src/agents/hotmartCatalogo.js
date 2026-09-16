'use strict';
/**
 * hotmartCatalogo.js — catalogo real da Hotmart e produtos duplicados.
 *
 * Medido em 16/09/2026: 1434 produtos, 160 titulos repetidos, 214 copias a
 * mais (a pior com 3 copias do mesmo livro japones, 09/09). Causa: o cadastro
 * falhava depois de criar o produto ("No product ID after creation"), o id
 * nunca voltava ao banco e a proxima rodada criava outro. Uma venda do dia caiu
 * numa copia (#8397316) que o banco nao conhecia.
 *
 * Aqui: baixar o catalogo, agrupar por titulo, escolher a copia que fica e
 * traduzir venda de copia para o produto que ficou.
 */
const API = 'https://api-product.vulcano.hotmart.com/product/v2/product';

/** Chave de titulo: mesmo texto com caixa, espacos e largura normalizados. Pura. */
function normalizar(titulo) {
  return String(titulo || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Todas as paginas do catalogo do produtor. */
async function baixarCatalogo(token, { fetchImpl = fetch, porPagina = 100, maxPaginas = 200 } = {}) {
  const todos = [];
  for (let p = 1; p <= maxPaginas; p++) {
    const r = await fetchImpl(`${API}?page=${p}&rows=${porPagina}`, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    });
    if (!r.ok) throw new Error('catalogo HTTP ' + r.status + ' na pagina ' + p);
    const lista = ((await r.json()) || {}).data || [];
    todos.push(...lista);
    if (lista.length < porPagina) break;
  }
  return todos;
}

/** Grupos (2+) de produtos nao excluidos com o mesmo titulo. Pura. */
function agruparDuplicados(catalogo) {
  const grupos = new Map();
  for (const p of catalogo || []) {
    if (!p || p.deleted) continue;
    const k = normalizar(p.name);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(p);
  }
  return [...grupos.values()].filter(g => g.length > 1);
}

/**
 * Ordem de preferencia de quem fica: em destaque, conhecido pelo banco, com
 * venda, ativo, mais antigo. Pura.
 * @param info {{destaques:Set, noBanco:Set, vendas:Map, semArquivo:Set}}
 */
function ordenarGrupo(grupo, info) {
  const id = p => String(p.id);
  const peso = p => [
    info.semArquivo.has(id(p)) ? 0 : 1,
    info.destaques.has(id(p)) ? 1 : 0,
    info.noBanco.has(id(p)) ? 1 : 0,
    info.vendas.get(id(p)) || 0,
    p.status === 'ACTIVE' ? 1 : 0,
  ];
  return [...grupo].sort((a, b) => {
    const pa = peso(a), pb = peso(b);
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return (a.creationDate || 0) - (b.creationDate || 0);
  });
}

/**
 * Primeiro da ordem com arquivo CONFIRMADO fica; o resto sao copias.
 * `temArquivo(id)` devolve true/false/null (null = nao deu para saber).
 * Sem nenhum confirmado, o grupo fica como esta (null).
 */
async function decidirGrupo(grupo, info, temArquivo) {
  const ordem = ordenarGrupo(grupo, info);
  for (const p of ordem) {
    if (await temArquivo(String(p.id)) === true) {
      return { fica: String(p.id), copias: ordem.filter(x => x !== p).map(x => String(x.id)) };
    }
  }
  return null;
}

/** Venda de copia passa a contar no produto que ficou; guarda o id original. Pura. */
function aplicarCanonico(vendas, mapa) {
  return vendas.map(v => {
    const destino = mapa.get(String(v.produtoId));
    return destino ? { ...v, produtoId: destino, produtoOriginal: String(v.produtoId) } : { ...v, produtoOriginal: null };
  });
}

/** Ids ja existentes na Hotmart para um titulo (mais antigo primeiro). Pura. */
function idsPorTitulo(catalogo, titulo) {
  const k = normalizar(titulo);
  if (!k) return [];
  return (catalogo || [])
    .filter(p => p && !p.deleted && normalizar(p.name) === k)
    .sort((a, b) => (a.creationDate || 0) - (b.creationDate || 0))
    .map(p => String(p.id));
}

module.exports = { normalizar, baixarCatalogo, agruparDuplicados, ordenarGrupo, decidirGrupo, aplicarCanonico, idsPorTitulo };
