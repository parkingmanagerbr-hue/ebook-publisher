'use strict';
/**
 * pagina.js — a ferramenta que o comprador usa. HTML puro, um arquivo, sem
 * servidor e sem IA: o progresso fica no navegador dele (localStorage).
 *
 * Fica fora do alcance dos buscadores (noindex): o acesso e pela area de
 * membros da loja, e a pagina indexada viraria ferramenta gratis para quem nao
 * comprou.
 *
 * Tudo que vem do livro passa por `esc` — o texto nasceu de IA e de PDF, e
 * nenhum dos dois e confiavel para ir cru para dentro de HTML.
 */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const ESTILO = [
  ':root{--fundo:#f6f7f9;--cartao:#fff;--texto:#1c2330;--suave:#5b6474;--linha:#e3e6ec;--marca:#2f7d5b;--aviso:#fff7e6;--aviso-borda:#f0c36d}',
  '@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--fundo:#0f1217;--cartao:#171b22;--texto:#e7eaf0;--suave:#9aa3b2;--linha:#262c36;--marca:#5cc195;--aviso:#2b2414;--aviso-borda:#7a5d20;color-scheme:dark}}',
  ':root[data-theme=dark]{--fundo:#0f1217;--cartao:#171b22;--texto:#e7eaf0;--suave:#9aa3b2;--linha:#262c36;--marca:#5cc195;--aviso:#2b2414;--aviso-borda:#7a5d20;color-scheme:dark}',
  '*{box-sizing:border-box}body{margin:0;background:var(--fundo);color:var(--texto);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
  '.pag{max-width:860px;margin:0 auto;padding:24px 16px 64px}',
  'header h1{font-size:1.45rem;margin:0 0 4px}header p{margin:0;color:var(--suave)}',
  '.progresso{margin:20px 0;background:var(--cartao);border:1px solid var(--linha);border-radius:12px;padding:14px 16px}',
  '.barra{height:10px;background:var(--linha);border-radius:99px;overflow:hidden;margin-top:8px}.barra i{display:block;height:100%;background:var(--marca);width:0;transition:width .3s}',
  '.aviso{background:var(--aviso);border:1px solid var(--aviso-borda);border-radius:10px;padding:10px 14px;font-size:.92rem;margin:16px 0}',
  'nav.abas{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}nav.abas button{border:1px solid var(--linha);background:var(--cartao);color:var(--texto);padding:8px 14px;border-radius:99px;cursor:pointer;font:inherit}',
  'nav.abas button[aria-selected=true]{background:var(--marca);border-color:var(--marca);color:#fff}',
  'details{background:var(--cartao);border:1px solid var(--linha);border-radius:12px;margin:10px 0;padding:0 16px}',
  'summary{cursor:pointer;padding:14px 0;font-weight:600;display:flex;justify-content:space-between;gap:12px}summary span{color:var(--suave);font-weight:400;white-space:nowrap}',
  'details p.resumo{margin:0 0 8px;color:var(--suave)}',
  'label.acao{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--linha);cursor:pointer}label.acao input{margin-top:4px;width:18px;height:18px;accent-color:var(--marca)}',
  'label.acao.feita span{color:var(--suave);text-decoration:line-through}',
  '.tabela{overflow-x:auto;background:var(--cartao);border:1px solid var(--linha);border-radius:12px}',
  'table{border-collapse:collapse;width:100%;min-width:520px}th,td{padding:10px 8px;border-bottom:1px solid var(--linha);text-align:center}th:first-child,td:first-child{text-align:left}',
  'td input{width:18px;height:18px;accent-color:var(--marca)}',
  'textarea{width:100%;min-height:260px;background:var(--cartao);color:var(--texto);border:1px solid var(--linha);border-radius:12px;padding:12px;font:inherit}',
  '.acoes-pagina{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.acoes-pagina button{border:1px solid var(--linha);background:var(--cartao);color:var(--texto);padding:8px 14px;border-radius:8px;cursor:pointer;font:inherit}',
  'footer{margin-top:40px;color:var(--suave);font-size:.85rem}',
  '[hidden]{display:none!important}',
  '@media print{nav.abas,.acoes-pagina{display:none}details{break-inside:avoid}}',
].join('\n');

// Roda no navegador do comprador. Fica como texto porque vai dentro do HTML.
const SCRIPT = [
  '(function(){',
  '  var CHAVE = document.body.getAttribute("data-chave");',
  '  var estado = {};',
  '  try { estado = JSON.parse(localStorage.getItem(CHAVE) || "{}") || {}; } catch (e) { estado = {}; }',
  '  function salvar(){ try { localStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) {} }',
  '  function atualizar(){',
  '    var acoes = document.querySelectorAll("input[data-id^=a]"), feitas = 0;',
  '    acoes.forEach(function(c){ if (c.checked) feitas++; var l = c.closest("label"); if (l) l.classList.toggle("feita", c.checked); });',
  '    document.getElementById("texto-progresso").textContent = feitas + " de " + acoes.length + " passos feitos";',
  '    document.getElementById("barra").style.width = (acoes.length ? Math.round(feitas * 100 / acoes.length) : 0) + "%";',
  '    document.querySelectorAll("[data-cap]").forEach(function(s){',
  '      var i = s.getAttribute("data-cap"), t = 0, f = 0;',
  '      document.querySelectorAll("input[data-id^=a" + i + "_]").forEach(function(c){ t++; if (c.checked) f++; });',
  '      s.textContent = f + "/" + t;',
  '    });',
  '  }',
  '  document.querySelectorAll("input[type=checkbox][data-id]").forEach(function(c){',
  '    c.checked = !!estado[c.getAttribute("data-id")];',
  '    c.addEventListener("change", function(){ estado[c.getAttribute("data-id")] = c.checked; salvar(); atualizar(); });',
  '  });',
  '  var notas = document.getElementById("notas");',
  '  notas.value = estado._notas || "";',
  '  notas.addEventListener("input", function(){ estado._notas = notas.value; salvar(); });',
  '  var nova = document.getElementById("nova-semana");',
  '  if (nova) nova.addEventListener("click", function(){',
  '    Object.keys(estado).forEach(function(k){ if (k.charAt(0) === "h") delete estado[k]; });',
  '    document.querySelectorAll("input[data-id^=h]").forEach(function(c){ c.checked = false; });',
  '    salvar();',
  '  });',
  '  document.querySelectorAll("[data-aba]").forEach(function(b){',
  '    b.addEventListener("click", function(){',
  '      var alvo = b.getAttribute("data-aba");',
  '      document.querySelectorAll("[data-aba]").forEach(function(x){ x.setAttribute("aria-selected", String(x === b)); });',
  '      document.querySelectorAll("[data-painel]").forEach(function(p){ p.hidden = p.getAttribute("data-painel") !== alvo; });',
  '    });',
  '  });',
  '  atualizar();',
  '})();',
].join('\n');

/** Monta a página inteira da ferramenta. `chave` separa o progresso por livro. Pura. */
function paginaDaFerramenta(esp, { chave = 'livro' } = {}) {
  const e = esp || {};
  const caps = Array.isArray(e.capitulos) ? e.capitulos : [];
  const habitos = Array.isArray(e.habitos) ? e.habitos : [];
  const idChave = 'vx-ferramenta-' + (String(chave).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'livro');

  const plano = caps.map((c, i) => {
    const acoes = ((c && c.acoes) || []).map((a, j) =>
      '<label class="acao"><input type="checkbox" data-id="a' + i + '_' + j + '"><span>' + esc(a) + '</span></label>').join('');
    return '<details' + (i === 0 ? ' open' : '') + '><summary>' + esc(c && c.titulo) + '<span data-cap="' + i + '"></span></summary>' +
      (c && c.resumo ? '<p class="resumo">' + esc(c.resumo) + '</p>' : '') + acoes + '</details>';
  }).join('');

  const cabecalhoDias = DIAS.map(d => '<th>' + d + '</th>').join('');
  const linhasHabitos = habitos.map((h, i) => '<tr><td>' + esc(h) + '</td>' +
    DIAS.map((d, k) => '<td><input type="checkbox" data-id="h' + i + '_' + k + '" aria-label="' + esc(h) + ' — ' + d + '"></td>').join('') +
    '</tr>').join('');
  const painelHabitos = habitos.length
    ? '<div class="tabela"><table><thead><tr><th>Hábito</th>' + cabecalhoDias + '</tr></thead><tbody>' + linhasHabitos +
      '</tbody></table></div><div class="acoes-pagina"><button type="button" id="nova-semana">Começar nova semana</button></div>'
    : '<p>Este livro não traz hábitos semanais.</p>';

  return '<!doctype html><html lang="' + esc(e.idioma || 'pt-BR') + '"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<title>Plano de ação — ' + esc(e.titulo) + '</title>\n' +
    '<style>' + ESTILO + '</style></head><body data-chave="' + esc(idChave) + '"><div class="pag">\n' +
    '<header><h1>' + esc(e.titulo) + '</h1>' + (e.subtitulo ? '<p>' + esc(e.subtitulo) + '</p>' : '') + '</header>\n' +
    '<div class="progresso"><strong id="texto-progresso">0 de 0 passos feitos</strong><div class="barra"><i id="barra"></i></div></div>\n' +
    (e.aviso ? '<div class="aviso">' + esc(e.aviso) + '</div>\n' : '') +
    '<nav class="abas" role="tablist">' +
    '<button type="button" role="tab" aria-selected="true" data-aba="plano">Plano de ação</button>' +
    '<button type="button" role="tab" aria-selected="false" data-aba="habitos">Hábitos da semana</button>' +
    '<button type="button" role="tab" aria-selected="false" data-aba="notas">Anotações</button></nav>\n' +
    '<section data-painel="plano">' + plano + '</section>\n' +
    '<section data-painel="habitos" hidden>' + painelHabitos + '</section>\n' +
    '<section data-painel="notas" hidden><textarea id="notas" placeholder="Suas anotações ficam salvas neste navegador."></textarea></section>\n' +
    '<div class="acoes-pagina"><button type="button" onclick="window.print()">Imprimir ou salvar em PDF</button></div>\n' +
    '<footer>Veloxis Editorial · o seu progresso fica salvo neste navegador</footer>\n' +
    '</div><script>' + SCRIPT + '</script></body></html>';
}

module.exports = { paginaDaFerramenta, esc };
