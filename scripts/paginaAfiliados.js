'use strict';
/**
 * paginaAfiliados.js — pagina publica para quem quer divulgar os livros.
 *
 * Por que (18/09/2026): a afiliacao esta aberta (50% no catalogo, 70% nos
 * destaques, cookie eterno) e os produtos estao no Mercado da Hotmart, mas
 * ninguem chega ate eles: a vitrine teve 1 visita humana em 36 h. Esta pagina
 * e o que se manda para um afiliado — comissao, link de afiliacao de cada
 * livro e o que pode ou nao ser dito na divulgacao.
 *
 * Nada de numero de venda, depoimento ou avaliacao: o catalogo nao tem.
 */
const PRODUTOR_UCODE = process.env.HOTMART_PRODUCER_UCODE || 'ff801bff-1ab0-4ba5-a995-d18721270b94';
const BASE_URL = 'https://veloxisit.com.br/livros/';

/** Link de afiliacao no Mercado da Hotmart. Pura. */
function linkAfiliacao(ucode, produtor = PRODUTOR_UCODE) {
  if (!ucode) return null;
  return 'https://app.hotmart.com/market/details?producerUcode=' + produtor + '&productUcode=' + ucode;
}

/** Quanto o afiliado recebe por venda aprovada. Pura. */
function ganhoAfiliado(preco, comissao) {
  return Number(preco || 0) * (Number(comissao || 0) / 100);
}

function montarPaginaAfiliados(livros, ferramentas, agora = new Date()) {
  const { esc, precoBR } = ferramentas;
  const linhas = (livros || []).map(l => {
    const link = linkAfiliacao(l.ucode);
    const afiliar = link
      ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">Afiliar-se</a>'
      : '<span>pelo Mercado da Hotmart</span>';
    return '<tr><td><a href="../' + esc(l.slug) + '/">' + esc(l.titulo) + '</a></td>' +
      '<td>' + esc(precoBR(l.preco)) + '</td>' +
      '<td>' + esc(String(l.comissao || 0)) + '%</td>' +
      '<td>' + esc(precoBR(ganhoAfiliado(l.preco, l.comissao))) + '</td>' +
      '<td>' + afiliar + '</td></tr>';
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Programa de afiliados — Veloxis Editorial</title>
<meta name="description" content="Divulgue e-books da Veloxis Editorial: comissão de até 70%, afiliação de 1 clique pela Hotmart e material pronto para divulgar.">
<link rel="canonical" href="${BASE_URL}afiliados/">
<meta property="og:title" content="Programa de afiliados — Veloxis Editorial">
<meta property="og:url" content="${BASE_URL}afiliados/">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0e0e1a;color:#f2f2f7;line-height:1.55}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 40px}
a{color:#ffcf5a}
h1{font-size:clamp(22px,3.6vw,30px);margin-bottom:8px}
h2{font-size:19px;margin:26px 0 10px}
p,li{color:#dcdce8;margin-bottom:8px}
ul{margin-left:18px}
.tabela{overflow-x:auto;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border-bottom:1px solid #26264a;padding:8px;text-align:left;white-space:nowrap}
th{color:#a9a9c0;font-weight:600}
footer{margin-top:30px;color:#77778f;font-size:12px}
</style></head><body><div class="wrap">
<h1>Programa de afiliados</h1>
<p>E-books em PDF da Veloxis Editorial, com pagamento e entrega imediata pela Hotmart.</p>
<h2>Como funciona</h2>
<ul>
<li>Comissão de 50% no catálogo e 70% nos livros em destaque, sobre cada venda aprovada.</li>
<li>Afiliação de 1 clique: não há fila de aprovação.</li>
<li>Cookie eterno na Hotmart: a venda fica com quem trouxe o comprador.</li>
<li>Pagamento da comissão e suporte ao comprador pela própria Hotmart.</li>
</ul>
<h2>Livros em destaque</h2>
<div class="tabela"><table><thead><tr><th>Livro</th><th>Preço</th><th>Comissão</th><th>Você recebe</th><th>Afiliar</th></tr></thead><tbody>${linhas}</tbody></table></div>
<h2>Material para divulgar</h2>
<ul>
<li>Capa: abra a página do livro e salve a imagem.</li>
<li>Texto: use a descrição da própria página do livro, sem acrescentar promessa de resultado.</li>
<li>Link: use sempre o seu link de afiliado, gerado pela Hotmart depois da afiliação.</li>
</ul>
<h2>Regras de divulgação</h2>
<ul>
<li>Sem promessa de ganho, cura ou resultado garantido.</li>
<li>Sem número de vendas, depoimento ou avaliação que você não tenha.</li>
<li>Sem spam: nada de disparo em massa, comentário repetido ou lista comprada.</li>
<li>Não se passe pela Veloxis Editorial nem crie página que imite a nossa.</li>
</ul>
<footer>Veloxis Editorial · atualizado em ${agora.toISOString().slice(0, 10)} · <a href="../">ver os livros</a></footer>
</div></body></html>
`;
}

module.exports = { montarPaginaAfiliados, linkAfiliacao, ganhoAfiliado, PRODUTOR_UCODE };
