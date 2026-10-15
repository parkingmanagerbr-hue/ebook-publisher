'use strict';
/**
 * publicar_gplay.js — publica e-books no Google Play Livros (Partner Center)
 * pelo Chrome da VPS (container navegador-hotmart).
 *
 * Fluxo medido com o dono em 13/10/2026, no primeiro livro (GGKEY:SJ22W106K4J):
 * criar (#book/create) -> About -> Genres -> Contributors -> Series -> Settings
 * -> Content (PDF + capa) -> Pricing -> Review -> Publish. A UI e Angular
 * Material sem rotulo nos inputs: cada campo e achado pelo TEXTO do rotulo que
 * vem antes dele na pagina. Cliques por element.click() de dentro da pagina:
 * o h.click() do puppeteer estourou o protocolTimeout com a aba em segundo
 * plano, e o dono usa o mesmo Chrome pela tela remota — nao se rouba o foco.
 *
 * Travas (regras em src/agents/gplayRegras.js, com teste):
 *   - PORTAO: livro novo so sai quando o primeiro livro da conta estiver no
 *     ar. Enquanto a conta esta em revisao, a rodada registra e sai 0.
 *   - teto diario (GPLAY_TETO_DIA, padrao 2) no fuso do negocio;
 *   - um publicador por vez (travaLocal 'gplay' + flock no laco);
 *   - 3 reprovacoes seguidas param a loja (linha GPLAY_PARADO no log);
 *   - GGKEY gravado no banco no INSTANTE em que nasce: queda depois retoma o
 *     rascunho, nao cria outro.
 *
 * Uso (no container, PUBLICAR_NO_SERVIDOR=1):
 *   node scripts/publicar_gplay.js                 # rodada normal
 *   node scripts/publicar_gplay.js --dry-run       # tudo ate o Review, SEM Publish (ignora portao e teto)
 *   node scripts/publicar_gplay.js --livro=<id>    # so este livro
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('../src/agents/gplayRegras');
const { prepararPdf } = require('../src/agents/gplayArquivos');
const { pastaTemporaria } = require('../src/core/modoServidor');
const { travar } = require('../src/core/travaLocal');
const { precoDaLoja } = require('../src/core/precoProprio');

let log;
try { log = require('../src/core/logger').createLogger('gplay'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const CONTA = process.env.GPLAY_CONTA_URL || 'https://play.google.com/books/publish/u/0/a/2488284074839418498';
const LIVRO_PORTAO = process.env.GPLAY_LIVRO_PORTAO || 'GGKEY:SJ22W106K4J';
const AUTOR = 'Veloxis Editorial';
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : p; };
const temFlag = n => process.argv.includes('--' + n);
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const dormir = ms => new Promise(r => setTimeout(r, ms));
/** Promessa com prazo: chamada de CDP pendurada vira erro com nome, nao espera eterna. */
const comPrazo = (p, ms, oQue) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('GPLAY_PRAZO: ' + oQue)), ms))]);

// ── banco ────────────────────────────────────────────────────────────────────

function prepararBanco(db) {
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  for (const c of ['gplay_id', 'gplay_url', 'gplay_estado', 'gplay_quando', 'combo_de', 'audio_de']) {
    if (!cols.includes(c)) db.prepare('ALTER TABLE ebooks ADD COLUMN ' + c + ' TEXT').run();
  }
  db.prepare('CREATE TABLE IF NOT EXISTS gplay_eventos (ebook_id TEXT, gplay_id TEXT, quando INTEGER, dia TEXT, tipo TEXT, detalhe TEXT)').run();
}

function evento(db, ebookId, gplayId, tipo, detalhe = '') {
  db.prepare('INSERT INTO gplay_eventos (ebook_id, gplay_id, quando, dia, tipo, detalhe) VALUES (?,?,?,?,?,?)')
    .run(ebookId || null, gplayId || null, Date.now(), R.diaDoNegocio(), tipo, umaLinha(detalhe, 300));
}

function marcar(db, ebookId, campos) {
  const chaves = Object.keys(campos);
  db.prepare('UPDATE ebooks SET ' + chaves.map(k => k + ' = ?').join(', ') + ', gplay_quando = ? WHERE id = ?')
    .run(...chaves.map(k => campos[k]), String(Date.now()), ebookId);
}

/** Candidatos com os dados que a fila precisa (decisao em gplayRegras). */
function candidatos(db, { so } = {}) {
  const linhas = db.prepare(
    'SELECT rowid, id, title, subtitle, description, language, topic, price, pdf_path, cover_path, combo_de, audio_de, ' +
    "gplay_id, gplay_estado, hotmart_product_id FROM ebooks WHERE (gplay_estado IS NULL OR gplay_estado IN ('', 'rascunho')) " +
    (so ? 'AND id = ? ' : '') + "AND status IN ('ready', 'published') AND title IS NOT NULL AND title <> ''"
  ).all(...(so ? [so] : []));
  const vendidos = new Set();
  try {
    const vendas = db.prepare("SELECT produto_id, produto, produto_original FROM vendas_hotmart WHERE suspeita = 0 AND status IN ('COMPLETE', 'APPROVED')").all();
    const porProduto = new Map(linhas.filter(l => l.hotmart_product_id).map(l => [String(l.hotmart_product_id), l.id]));
    const porTitulo = new Map(linhas.map(l => [String(l.title).trim().toLowerCase(), l.id]));
    for (const v of vendas) {
      const id = porProduto.get(String(v.produto_id)) || porTitulo.get(String(v.produto || '').trim().toLowerCase()) || porTitulo.get(String(v.produto_original || '').trim().toLowerCase());
      if (id) vendidos.add(id);
    }
  } catch (e) { log.warn('vendas_hotmart ilegivel — fila sem prioridade de venda: ' + umaLinha(e.message)); }
  let comTexto = new Set();
  try { comTexto = new Set(db.prepare('SELECT ebook_id FROM ebook_conteudo').all().map(r => r.ebook_id)); }
  catch (e) { log.warn('ebook_conteudo ilegivel: ' + umaLinha(e.message)); }
  return R.ordenarFila(linhas, { vendidos, comTexto });
}

// ── funcoes de pagina (rodam DENTRO da aba) ──────────────────────────────────

const AJUDA = `
window.__gp = (() => {
  const t = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const todos = sel => [...document.querySelectorAll(sel)].filter(vis);
  // Elemento folha cujo texto e exatamente o rotulo.
  const rotulo = txt => todos('body *').find(e => e.children.length === 0 && t(e.textContent) === txt) ||
    todos('body *').find(e => t(e.textContent) === txt && [...e.children].every(c => !t(c.textContent)));
  const depois = (ref, sel) => todos(sel).find(e => ref.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
  return {
    texto: () => t(document.body.innerText),
    hash: () => location.hash,
    campo: (txt, sel) => { const r = rotulo(txt); const e = r && depois(r, sel); if (e) e.setAttribute('data-gp', txt); return !!e; },
    preencher: (marca, valor) => {
      const el = document.querySelector('[data-gp="' + marca + '"]');
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, valor);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    },
    valor: marca => { const el = document.querySelector('[data-gp="' + marca + '"]'); return el ? t(el.value != null ? el.value : el.textContent) : null; },
    clicar: (txt, dentro) => {
      const raiz = dentro ? document.querySelector(dentro) : document;
      if (!raiz) return false;
      const c = [...raiz.querySelectorAll('button, [role=button], a, mat-option, [role=option], mat-chip-option')].filter(vis);
      // Botao com icone tem o texto do icone colado na frente ("addAdd a genre",
      // "uploadUpload a file"). Aceita SO prefixo de icone (minusculas e _):
      // "Continue" nao pode casar "Save & Continue", nem "Publish" um "Unpublish".
      const sem = s => t(s).replace(/\s+/g, '');
      const alvo = sem(txt);
      const comIcone = e => { const x = sem(e.textContent); return x.endsWith(alvo) && /^[a-z_]+$/.test(x.slice(0, x.length - alvo.length)); };
      const el = c.find(e => t(e.textContent) === txt) || c.find(comIcone);
      if (!el) return false;
      el.click(); return true;
    },
    abrirSelect: n => { const s = todos('mat-select')[n]; if (!s) return false; (s.querySelector('.mat-mdc-select-trigger') || s).click(); return true; },
    selects: () => todos('mat-select').map(s => t(s.textContent)),
    opcoes: () => todos('mat-option, [role=option]').map(o => t(o.textContent)),
    clicarOpcao: txt => { const o = todos('mat-option, [role=option]').find(e => t(e.textContent) === txt); if (!o) return false; o.click(); return true; },
    erros: () => todos('mat-error, .mat-mdc-form-field-error, [role=alert]').map(e => t(e.textContent)).filter(Boolean),
    descricao: valor => {
      const ed = todos('.ql-editor')[0];
      if (!ed) return false;
      ed.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(ed);
      document.execCommand('insertText', false, valor);
      return true;
    },
    lerDescricao: () => { const ed = todos('.ql-editor')[0]; return ed ? t(ed.innerText) : null; },
    chipNao: () => {
      const c = todos('mat-chip-option').find(e => t(e.textContent) === 'No');
      if (!c) return 'sem-chip';
      if (c.getAttribute('aria-selected') !== 'true' && !c.classList.contains('mat-mdc-chip-selected')) c.click();
      return 'ok';
    },
    linkPublico: () => [...document.querySelectorAll('a[href]')].map(a => a.href).find(h => /play\\.google\\.com\\/store\\/books\\/details\\?id=/.test(h)) || null,
  };
})();`;

async function ajuda(page) { await page.evaluate(AJUDA); }
// A aplicacao troca de documento entre as abas do editor e a leitura que pega
// a troca no meio morre com "detached Frame" (medido em 15/10/2026, logo depois
// de um Save & Continue). Isso e navegacao, nao falha: espera e le de novo.
const TROCA_DE_PAGINA = /detached Frame|Execution context was destroyed|Cannot find context with specified id/;

async function gp(page, fn, ...args) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      await ajuda(page);
      return await page.evaluate((f, a) => window.__gp[f](...a), fn, args);
    } catch (e) {
      if (tentativa >= 4 || !TROCA_DE_PAGINA.test(String(e && e.message))) throw e;
      log.warn('  leitura pegou troca de pagina (' + fn + ', tentativa ' + tentativa + ') — lendo de novo');
      await dormir(1500);
    }
  }
}

/**
 * Texto que so aparece quando a aba do editor CARREGOU. A troca de aba e por
 * hash (mesmo documento) e demora mais que qualquer espera fixa: com 8 s a
 * etapa "Settings" ainda lia a pagina de "Series" e clicava o Continue dela.
 */
const PRONTO = {
  'info/about': /About the book/, 'info/genres': /Make it easy for readers/, 'info/contributors': /Tell readers about the people/,
  'info/series': /Add this book to series/, 'info/settings': /Decide how your book will appear/, content: /Upload and review the files/,
  pricing: /Set the prices/, review: /Book status|Book details/, list: /Book catalog/, 'book/create': /Select a sell option|Sell option/,
};

async function ir(page, hash, espera = 3000) {
  await page.goto(CONTA + '#' + hash, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log.warn('goto ' + hash + ': ' + umaLinha(e.message)));
  const chave = Object.keys(PRONTO).find(k => hash === k || hash.endsWith('/' + k));
  const fim = Date.now() + 45000;
  while (chave && Date.now() < fim) {
    await dormir(1500);
    // Sessao do Google caida: o Partner Center manda para a escolha de conta.
    // Medido em 14/10/2026, logo depois de o Chrome da VPS ser reiniciado.
    if (R.pedeLogin(page.url())) throw new Error('GPLAY_SEM_SESSAO');
    const lido = await page.evaluate(re => ({ hash: location.hash, pronto: new RegExp(re).test(document.body.innerText) && !/Loading(?! complete)/.test(document.body.innerText.slice(-200)) }), PRONTO[chave].source).catch(() => ({}));
    const ok = lido.pronto && R.hashConfere(lido.hash, hash);
    if (ok) { await dormir(espera); return; }
  }
  if (chave) throw new Error('GPLAY_PAGINA_NAO_CARREGOU: ' + hash);
  await dormir(8000);
}

/** Espera o "Save" terminar: muda o endereco, ou aparece "saved", ou erro. */
async function esperarSalvar(page, hashAntes, oQue, prazo = 45000) {
  const fim = Date.now() + prazo;
  while (Date.now() < fim) {
    await dormir(1500);
    const erros = await gp(page, 'erros');
    if (erros.length) throw new Error('GPLAY_CAMPO_RECUSADO em ' + oQue + ': ' + umaLinha(erros.join(' | '), 200));
    const h = await gp(page, 'hash');
    if (h !== hashAntes) return h;
    if (/\bsaved\b|changes saved|salvo/i.test(await gp(page, 'texto'))) return h;
  }
  return gp(page, 'hash');
}

async function salvar(page, oQue) {
  const antes = await gp(page, 'hash');
  for (const b of ['Save & Continue', 'Save', 'Continue']) {
    if (await gp(page, 'clicar', b)) {
      const depois = await esperarSalvar(page, antes, oQue);
      log.info('  ' + oQue + ': "' + b + '" -> ' + umaLinha(depois, 80));
      return depois;
    }
  }
  throw new Error('GPLAY_SEM_BOTAO_SALVAR em ' + oQue);
}

async function escolherNoSelect(page, indice, opcao, oQue) {
  if ((await gp(page, 'selects'))[indice] === opcao) return;
  if (!await gp(page, 'abrirSelect', indice)) throw new Error('GPLAY_SEM_SELECT ' + oQue);
  await dormir(1200);
  if (!await gp(page, 'clicarOpcao', opcao)) throw new Error('GPLAY_SEM_OPCAO "' + opcao + '" em ' + oQue + ' (tem: ' + umaLinha((await gp(page, 'opcoes')).join(' | '), 160) + ')');
  await dormir(800);
}

async function autocomplete(page, marca, digitar, opcao, oQue) {
  if (!await gp(page, 'preencher', marca, digitar)) throw new Error('GPLAY_SEM_CAMPO ' + oQue);
  await dormir(2500);
  if (!await gp(page, 'clicarOpcao', opcao)) throw new Error('GPLAY_SEM_OPCAO "' + opcao + '" em ' + oQue + ' (tem: ' + umaLinha((await gp(page, 'opcoes')).join(' | '), 160) + ')');
  await dormir(800);
}

// ── etapas ───────────────────────────────────────────────────────────────────

/**
 * Livro com o mesmo titulo na lista da conta (o banco nao tinha o GGKEY).
 * Devolve { id, status } ou null. A lista mostra 10 por pagina; a busca da
 * propria lista filtra pelo titulo.
 */
async function acharNaLista(page, titulo) {
  await ir(page, 'list', 8000);
  await page.evaluate(v => {
    const c = [...document.querySelectorAll('input')].find(e => /search by title/i.test(e.getAttribute('placeholder') || '') && e.getBoundingClientRect().width > 0);
    if (!c) return;
    c.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(c, v);
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    c.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  }, String(titulo).slice(0, 60));
  await dormir(5000);
  const linhas = await page.evaluate(() => [...document.querySelectorAll('tr, mat-row, [role=row]')].map(r => String(r.innerText || '').replace(/\s+/g, ' ').trim()));
  const alvo = String(titulo).trim().toLowerCase();
  const linha = linhas.find(l => l.toLowerCase().startsWith(alvo) && R.ggkeyDe(l));
  if (!linha) return null;
  return { id: R.ggkeyDe(linha), status: linha.slice(linha.indexOf(R.ggkeyDe(linha))) };
}

async function criar(page, db, livro) {
  await ir(page, 'book/create', 7000);
  await escolherNoSelect(page, 0, 'Sell ebook on Google Play', 'criar');
  await escolherNoSelect(page, 1, 'Get a Google book ID (GGKEY)', 'criar');
  const antes = await gp(page, 'hash');
  if (!await gp(page, 'clicar', 'Save & Continue')) throw new Error('GPLAY_SEM_BOTAO_SALVAR em criar');
  const fim = Date.now() + 60000;
  while (Date.now() < fim) {
    await dormir(1500);
    const id = R.ggkeyDe(await gp(page, 'hash'));
    if (id) {
      // GRAVA JA: se cair daqui em diante, a proxima rodada retoma este rascunho.
      marcar(db, livro.id, { gplay_id: id, gplay_estado: 'rascunho' });
      evento(db, livro.id, id, 'rascunho', 'criado');
      log.info('rascunho criado ' + id + ' para livro ' + livro.id.slice(0, 8));
      return id;
    }
  }
  throw new Error('GPLAY_SEM_GGKEY: a criacao nao devolveu id (hash ' + umaLinha(antes) + ')');
}

async function sobre(page, id, d) {
  await ir(page, 'book/' + id + '/info/about');
  if (!await gp(page, 'campo', 'Title', 'input')) throw new Error('GPLAY_SEM_CAMPO Title');
  await gp(page, 'preencher', 'Title', d.titulo);
  if (d.subtitulo) {
    if (!await gp(page, 'campo', 'Subtitle', 'input')) { await gp(page, 'clicar', 'Add a subtitle'); await dormir(1000); }
    if (await gp(page, 'campo', 'Subtitle', 'input')) await gp(page, 'preencher', 'Subtitle', d.subtitulo);
    else log.warn('  sem campo de subtitulo — segue sem');
  }
  if (!await gp(page, 'descricao', d.descricao)) throw new Error('GPLAY_SEM_CAMPO Description');
  if (!await gp(page, 'campo', 'Language', 'input')) throw new Error('GPLAY_SEM_CAMPO Language');
  if (await gp(page, 'valor', 'Language') !== d.idioma) await autocomplete(page, 'Language', d.idioma.slice(0, 6), d.idioma, 'idioma');
  if (await gp(page, 'campo', 'Publisher', 'input') && !await gp(page, 'valor', 'Publisher')) await gp(page, 'preencher', 'Publisher', AUTOR);
  if (!await gp(page, 'campo', 'Page count', 'input')) throw new Error('GPLAY_SEM_CAMPO Page count');
  await gp(page, 'preencher', 'Page count', String(d.paginas));
  const chip = await gp(page, 'chipNao');
  if (chip !== 'ok') log.warn('  "For mature audiences?": ' + chip);
  await salvar(page, 'about');
  // Conferir RECARREGANDO: a descricao do primeiro livro ficou vazia (ql-blank)
  // mesmo com o texto na tela antes de salvar.
  await ir(page, 'book/' + id + '/info/about');
  // O texto "About the book" aparece antes de a aplicacao preencher os campos:
  // lida na hora, a conferencia viu titulo vazio num rascunho com tudo gravado
  // (15/10/2026). Espera o titulo chegar antes de julgar.
  let titulo = '';
  for (let fim = Date.now() + 20000; Date.now() < fim; await dormir(1000)) {
    await gp(page, 'campo', 'Title', 'input');
    titulo = await gp(page, 'valor', 'Title');
    if (titulo) break;
  }
  const gravada = await gp(page, 'lerDescricao');
  if (titulo !== d.titulo) throw new Error('GPLAY_TITULO_NAO_GRAVOU: "' + umaLinha(titulo) + '"');
  if (!gravada || gravada.slice(0, 40) !== d.descricao.replace(/\s+/g, ' ').slice(0, 40)) throw new Error('GPLAY_DESCRICAO_NAO_GRAVOU: "' + umaLinha(gravada, 60) + '"');
  log.info('  about conferido (titulo e descricao gravados, ' + gravada.length + ' caracteres)');
}

async function generos(page, id, lista) {
  await ir(page, 'book/' + id + '/info/genres');
  const contar = () => page.evaluate(() => [...document.querySelectorAll('input[formcontrolname=code]')].filter(e => e.getBoundingClientRect().width > 0).length);
  while (await contar() < lista.length) { if (!await gp(page, 'clicar', 'Add a genre')) break; await dormir(1200); }
  for (let i = 0; i < lista.length; i++) {
    const tipos = await page.evaluate(() => [...document.querySelectorAll('mat-select[formcontrolname=type]')].filter(e => e.getBoundingClientRect().width > 0).length);
    if (i < tipos) {
      const todosSelects = await gp(page, 'selects');
      const idx = await page.evaluate(k => {
        const s = [...document.querySelectorAll('mat-select')].filter(e => e.getBoundingClientRect().width > 0);
        const tipo = [...document.querySelectorAll('mat-select[formcontrolname=type]')].filter(e => e.getBoundingClientRect().width > 0)[k];
        return s.indexOf(tipo);
      }, i);
      if (todosSelects[idx] !== 'BISAC (North America)') await escolherNoSelect(page, idx, 'BISAC (North America)', 'genero ' + (i + 1));
    }
    await page.evaluate(k => {
      const c = [...document.querySelectorAll('input[formcontrolname=code]')].filter(e => e.getBoundingClientRect().width > 0)[k];
      if (c) c.setAttribute('data-gp', 'genero' + k);
    }, i);
    if (await gp(page, 'valor', 'genero' + i) === lista[i].rotulo) continue;
    await autocomplete(page, 'genero' + i, lista[i].codigo, R.opcaoDoGenero(lista[i].codigo), 'genero ' + (i + 1));
  }
  await salvar(page, 'generos');
  await ir(page, 'book/' + id + '/info/genres');
  const gravados = await page.evaluate(() => [...document.querySelectorAll('input[formcontrolname=code]')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.value));
  for (const g of lista) if (!gravados.includes(g.rotulo)) throw new Error('GPLAY_GENERO_NAO_GRAVOU: ' + g.codigo + ' (gravados: ' + umaLinha(gravados.join(' | '), 160) + ')');
  log.info('  generos conferidos: ' + lista.map(g => g.codigo).join(', '));
}

async function contribuidores(page, id) {
  await ir(page, 'book/' + id + '/info/contributors');
  const ok = await page.evaluate(() => {
    const c = [...document.querySelectorAll('input[formcontrolname=fullName]')].find(e => e.getBoundingClientRect().width > 0);
    if (c) c.setAttribute('data-gp', 'fullName');
    return !!c;
  });
  if (!ok) { await gp(page, 'clicar', 'Add a contributor'); await dormir(1200); }
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('input[formcontrolname=fullName]')].find(e => e.getBoundingClientRect().width > 0);
    if (c) c.setAttribute('data-gp', 'fullName');
  });
  if (await gp(page, 'valor', 'fullName') !== AUTOR && !await gp(page, 'preencher', 'fullName', AUTOR)) throw new Error('GPLAY_SEM_CAMPO fullName');
  await salvar(page, 'contribuidores');
}

// Serie: nada a gravar (livro avulso), e a aba e independente — nao se visita.
async function serieEConfig(page, id) {
  await ir(page, 'book/' + id + '/info/settings');
  await salvar(page, 'configuracoes');
}

async function arquivosNoConteudo(page, id) {
  await ir(page, 'book/' + id + '/content');
  return R.estadoDoConteudo(await gp(page, 'texto'));
}

async function conteudo(page, id, arquivos) {
  let estado = await arquivosNoConteudo(page, id);
  if (estado.pdf === 'falhou') throw new Error('GPLAY_ARQUIVO_RECUSADO: ' + umaLinha(estado.detalhe, 200));
  if (estado.pdf !== 'ausente' && estado.capa) { log.info('  conteudo ja enviado: pdf ' + estado.pdf + (estado.detalhe ? ' (' + estado.detalhe + ')' : '') + ', capa ok'); return estado.pdf; }
  if (!await gp(page, 'clicar', 'Upload a file')) throw new Error('GPLAY_SEM_BOTAO Upload a file');
  await dormir(2500);
  // O "Browse" so abre o seletor com clique CONFIAVEL (medido em 13/10/2026:
  // element.click(), soltar simulado na area de "Drag and drop" e interceptar
  // o input foram todos ignorados). O clique vai pelo CDP (Input.dispatch-
  // MouseEvent) com o FOCO EMULADO na aba (ver principal), o seletor e
  // interceptado pelo puppeteer — nenhuma janela abre na tela do dono.
  // Nome pela regra do Google: <id>.pdf e <id>_frontcover.jpg (o _frontcover
  // e o que faz a imagem virar a capa).
  const pdfNomeado = path.join(arquivos.dir, id + '.pdf');
  const capaNomeada = path.join(arquivos.dir, id + '_frontcover.jpg');
  fs.copyFileSync(arquivos.pdf, pdfNomeado); fs.chmodSync(pdfNomeado, 0o644);
  fs.copyFileSync(arquivos.capa, capaNomeada); fs.chmodSync(capaNomeada, 0o644);
  const alvo = await page.evaluate(() => {
    const d = document.querySelector('mat-dialog-container');
    const bt = d && [...d.querySelectorAll('button')].find(e => String(e.textContent).trim() === 'Browse');
    if (!bt) return null;
    const q = bt.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  if (!alvo) throw new Error('GPLAY_SEM_BOTAO Browse');
  const seletor = page.waitForFileChooser({ timeout: 30000 });
  await comPrazo(page.mouse.click(alvo.x, alvo.y), 30000, 'clique no Browse');
  const escolha = await seletor;
  await escolha.accept([pdfNomeado, capaNomeada]);
  log.info('  arquivos enviados ao dialogo — esperando processar');
  const fim = Date.now() + 8 * 60000;
  while (Date.now() < fim) {
    await dormir(15000);
    const dlg = await page.evaluate(() => { const d = document.querySelector('mat-dialog-container, [role=dialog]'); return d ? String(d.innerText).replace(/\s+/g, ' ').slice(0, 300) : ''; });
    log.info('  dialogo de envio: ' + umaLinha(dlg, 160));
    if (/error|fail|invalid/i.test(dlg)) throw new Error('GPLAY_ARQUIVO_RECUSADO: ' + umaLinha(dlg, 200));
    if (/done|complete|success|uploaded|100\s*%/i.test(dlg) || !dlg) break;
  }
  // Fecha SO o dialogo: o "Close" pelo texto, fora dele, casou o X de sair do editor.
  if (!await gp(page, 'clicar', 'Close', 'mat-dialog-container')) await page.keyboard.press('Escape').catch(() => {});
  await dormir(2000);
  // Conferir na aba: o PDF tem de aparecer (processado ou em processamento) e a
  // capa como _frontcover. O processamento do Google passa de 10 minutos; o
  // Publish espera por ele (publicarUm), a retomada nao reenvia.
  const fimProc = Date.now() + 3 * 60000;
  while (Date.now() < fimProc) {
    estado = await arquivosNoConteudo(page, id);
    if (estado.pdf === 'falhou') throw new Error('GPLAY_ARQUIVO_RECUSADO: ' + umaLinha(estado.detalhe, 200));
    if (estado.pdf !== 'ausente' && estado.capa) { log.info('  conteudo conferido: pdf ' + estado.pdf + (estado.detalhe ? ' (' + estado.detalhe + ')' : '') + ', _frontcover.jpg presente'); return estado.pdf; }
    await dormir(20000);
  }
  throw new Error('GPLAY_CONTEUDO_NAO_PROCESSOU: pdf=' + estado.pdf + ' capa=' + estado.capa);
}

async function precos(page, id, preco) {
  await ir(page, 'book/' + id + '/pricing');
  const temValor = () => page.evaluate(() => {
    const c = [...document.querySelectorAll('input[formcontrolname=saleAmount]')].find(e => e.getBoundingClientRect().width > 0);
    if (c) c.setAttribute('data-gp', 'saleAmount');
    return !!c;
  });
  if (!await temValor()) { await gp(page, 'clicar', 'Add a price'); await dormir(1500); }
  if (!await temValor()) throw new Error('GPLAY_SEM_CAMPO saleAmount');
  const idxMoeda = await page.evaluate(() => {
    const s = [...document.querySelectorAll('mat-select')].filter(e => e.getBoundingClientRect().width > 0);
    return s.indexOf(s.find(e => e.getAttribute('formcontrolname') === 'currency'));
  });
  if (idxMoeda >= 0) await escolherNoSelect(page, idxMoeda, 'BRL', 'moeda');
  await gp(page, 'preencher', 'saleAmount', preco);
  const sels = await gp(page, 'selects');
  const idxTerr = sels.findIndex((s, i) => i !== idxMoeda && s !== 'BRL');
  if (idxTerr >= 0 && sels[idxTerr] !== 'WORLD') await escolherNoSelect(page, idxTerr, 'WORLD', 'territorio');
  await salvar(page, 'precos');
  await ir(page, 'book/' + id + '/pricing');
  const texto = await gp(page, 'texto');
  if (!/Effective prices[^]*\b[A-Z]{3}\s[\d.,]+/.test(texto)) throw new Error('GPLAY_PRECO_SEM_PAISES');
  log.info('  preco conferido: BRL ' + preco + ', "Effective prices" com paises');
}

async function revisao(page, id) {
  await ir(page, 'book/' + id + '/review');
  return gp(page, 'texto');
}

// ── arquivos ─────────────────────────────────────────────────────────────────

async function prepararArquivos(livro) {
  const dir = pastaTemporaria('gplay');
  const nome = String(livro.id).slice(0, 8);
  const pdf = await prepararPdf(fs.readFileSync(livro.pdf_path), { titulo: livro.title, autor: AUTOR });
  const arqPdf = path.join(dir, nome + '.pdf');
  fs.writeFileSync(arqPdf + '.tmp', pdf.bytes);
  fs.renameSync(arqPdf + '.tmp', arqPdf);
  fs.chmodSync(arqPdf, 0o644);
  const arqCapa = path.join(dir, nome + '_capa.jpg');
  execFileSync('python3', [path.join(__dirname, 'capaKdp.py'), livro.cover_path, arqCapa, livro.title, livro.subtitle || '', AUTOR], { timeout: 120000 });
  fs.chmodSync(arqCapa, 0o644);
  log.info('  arquivos: PDF ' + pdf.paginas + ' paginas' + (pdf.tirouPrimeira ? ' (capa antiga em imagem removida)' : '') + ', capa com o titulo do cadastro');
  return { dir, pdf: arqPdf, capa: arqCapa, paginas: pdf.paginas };
}

// ── rodada ───────────────────────────────────────────────────────────────────

/** Le o estado dos livros ja enviados; grava o que mudou e devolve o do portao. */
async function atualizarEstados(page, db) {
  const enviados = db.prepare("SELECT id, gplay_id, gplay_estado FROM ebooks WHERE gplay_id IS NOT NULL AND gplay_id <> '' AND gplay_estado IN ('enviado', 'em-revisao')").all();
  let portao = null;
  const ids = new Set(enviados.map(e => e.gplay_id));
  for (const e of enviados.concat(ids.has(LIVRO_PORTAO) ? [] : [{ id: null, gplay_id: LIVRO_PORTAO, gplay_estado: null }])) {
    const texto = await revisao(page, e.gplay_id);
    const estado = R.estadoNaRevisao(texto);
    if (e.gplay_id === LIVRO_PORTAO) portao = estado;
    if (!e.id || estado === 'desconhecido') { if (estado === 'desconhecido') log.warn('estado ilegivel na revisao de ' + e.gplay_id); continue; }
    if (estado === 'live') {
      const url = R.urlPublicaDe(await gp(page, 'linkPublico'));
      marcar(db, e.id, { gplay_estado: 'live', gplay_url: url });
      evento(db, e.id, e.gplay_id, 'live', url || 'sem link publico na pagina');
      log.info('NO AR: ' + e.gplay_id + (url ? ' -> ' + url : ' (link publico ainda nao apareceu)'));
    } else if (estado === 'reprovado') {
      marcar(db, e.id, { gplay_estado: 'reprovado' });
      evento(db, e.id, e.gplay_id, 'reprovado', umaLinha(texto.slice(texto.search(/reject|not approved|violat/i)), 200));
      log.error('REPROVADO pelo Google: ' + e.gplay_id + ' (livro ' + e.id.slice(0, 8) + ')');
    } else if (e.gplay_estado !== 'em-revisao') marcar(db, e.id, { gplay_estado: 'em-revisao' });
  }
  return portao;
}

async function publicarUm(page, db, livro, { seco }) {
  const desc = R.limparDescricao(livro.description);
  const dados = {
    titulo: String(livro.title).trim(),
    subtitulo: String(livro.subtitle || '').trim(),
    descricao: desc.texto,
    idioma: R.idiomaGoogle(livro.language),
    generos: R.generosDoLivro(livro.topic, livro.title),
    preco: String(precoDaLoja(livro) || process.env.GPLAY_PRECO || R.PRECO_PADRAO),
  };
  log.info('livro ' + livro.id.slice(0, 8) + ' "' + umaLinha(dados.titulo) + '" | ' + dados.idioma + ' | ' + dados.generos.map(g => g.codigo).join(',') +
    ' | descricao ' + dados.descricao.length + ' caracteres (' + desc.removidas + ' frase(s) com alegacao removida(s))');
  const arquivos = await prepararArquivos(livro);
  dados.paginas = arquivos.paginas;
  try {
    let id = livro.gplay_id || null;
    if (!id) {
      const achado = await acharNaLista(page, dados.titulo);
      if (achado) {
        const d = R.oQueFazerComAchado(achado.status);
        log.info('ja existe na conta com o mesmo titulo: ' + achado.id + ' (' + umaLinha(achado.status, 60) + ') -> ' + d.acao);
        if (d.acao === 'ignorar') throw new Error('GPLAY_ACHADO_ILEGIVEL: ' + achado.id + ' existe e o estado nao se le — nada criado nem alterado');
        if (d.acao === 'registrar') {
          // Ja enviado ou no ar: NUNCA se edita de novo, so se registra.
          marcar(db, livro.id, { gplay_id: achado.id, gplay_estado: d.estado });
          evento(db, livro.id, achado.id, 'registrado', d.estado);
          return { id: achado.id, publicado: false, registrado: true };
        }
        marcar(db, livro.id, { gplay_id: achado.id, gplay_estado: 'rascunho' });
        id = achado.id;
      }
    }
    if (!id) id = await criar(page, db, livro);
    else log.info('retomando rascunho ' + id);
    await sobre(page, id, dados);
    await generos(page, id, dados.generos);
    await contribuidores(page, id);
    await serieEConfig(page, id);
    let pdf = await conteudo(page, id, arquivos);
    await precos(page, id, dados.preco);
    const texto = await revisao(page, id);
    const resumo = umaLinha(texto.slice(Math.max(0, texto.indexOf('Book details'))), 700);
    log.info('  review: ' + resumo);
    if (seco) { log.info('[dry-run] parado no Review de ' + id + ' — NAO publicado (pdf ' + pdf + ')'); return { id, publicado: false }; }
    if (pdf !== 'processado') pdf = (await arquivosNoConteudo(page, id)).pdf;
    if (pdf !== 'processado') {
      // Nao e falha: o Google ainda processa. A proxima rodada retoma o rascunho.
      log.info('aguardando o Google processar o PDF de ' + id + ' (' + pdf + ') — publica na proxima rodada');
      return { id, publicado: false, aguardando: true };
    }
    if (!await gp(page, 'clicar', 'Publish')) throw new Error('GPLAY_SEM_BOTAO Publish (review: ' + umaLinha(resumo, 200) + ')');
    const fim = Date.now() + 120000;
    while (Date.now() < fim) {
      await dormir(3000);
      const t = await gp(page, 'texto');
      if (/congratulations/i.test(t)) {
        marcar(db, livro.id, { gplay_estado: 'enviado' });
        evento(db, livro.id, id, 'publicado', dados.titulo);
        log.info('PUBLICADO (em revisao do Google): ' + id + ' "' + umaLinha(dados.titulo) + '"');
        return { id, publicado: true };
      }
      if (/is required|missing|error/i.test(await gp(page, 'erros').then(e => e.join(' ')))) break;
    }
    throw new Error('GPLAY_PUBLISH_SEM_CONFIRMACAO: ' + umaLinha(await gp(page, 'erros').then(e => e.join(' | ')), 200));
  } finally {
    try { fs.rmSync(arquivos.dir, { recursive: true, force: true }); } catch (_) { /* protocolo: pasta temporaria */ }
  }
}

async function principal() {
  const seco = temFlag('dry-run');
  const limite = Number(arg('limite', seco ? '1' : '2')) || 1;
  const db = require('../src/core/database').getDb();
  prepararBanco(db);

  const resultados = db.prepare("SELECT tipo FROM gplay_eventos WHERE tipo IN ('live', 'reprovado') ORDER BY quando").all().map(r => r.tipo);
  const seguidas = R.reprovacoesSeguidas(resultados);
  if (R.decidirRodada({ seguidas, seco }).acao === 'parar') {
    log.error('GPLAY_PARADO: ' + seguidas + ' reprovacoes seguidas do Google — a loja nao publica ate alguem revisar (gplay_eventos)');
    return { parado: true, reprovacoes: seguidas };
  }

  const soltar = seco ? () => {} : travar('gplay', { oQue: 'publicar_gplay', avisar: m => log.warn(m) });
  if (!soltar) { log.warn('outro publicador do Google Play esta rodando — saindo'); return { ocupado: true }; }
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: await require('../src/core/cdpLocal').urlCdpObrigatoria(), defaultViewport: null, protocolTimeout: 180000 });
  const page = await browser.newPage();
  // Foco EMULADO: a aba se comporta como focada sem tirar o foco da janela que
  // o dono usa pela tela remota. Sem isso o clique confiavel do upload nao
  // abre o seletor.
  await (await page.target().createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch(e => log.warn('foco emulado indisponivel: ' + umaLinha(e.message)));
  const r = { publicados: 0, falhas: 0, fila: 0 };
  try {
    const portao = await atualizarEstados(page, db);
    const hoje = db.prepare("SELECT count(*) n FROM gplay_eventos WHERE tipo = 'publicado' AND dia = ?").get(R.diaDoNegocio()).n;
    const teto = Number(process.env.GPLAY_TETO_DIA || R.TETO_DIA_PADRAO);
    const decisao = R.decidirRodada({ seguidas, portao, seco, hoje, teto, limite });
    log.info('portao (' + LIVRO_PORTAO + '): ' + portao + ' | hoje ' + hoje + ' de ' + teto + ' | decisao ' + decisao.acao + (seco ? ' (dry-run)' : ''));
    if (decisao.acao === 'esperar-conta') { log.info('conta em revisao: o primeiro livro ainda nao esta no ar — nenhum livro novo nesta rodada'); return { ...r, portao }; }
    if (decisao.acao === 'teto') { log.info('teto do dia atingido (' + hoje + ' de ' + teto + ')'); return { ...r, hoje }; }

    const fila = [];
    const motivos = {};
    for (const l of candidatos(db, { so: arg('livro', null) })) {
      const m = R.motivoParaNaoPublicar(l, { temPdf: !!(l.pdf_path && fs.existsSync(l.pdf_path)), temCapa: !!(l.cover_path && fs.existsSync(l.cover_path)) });
      if (m) { motivos[m] = (motivos[m] || 0) + 1; continue; }
      fila.push(l);
    }
    r.fila = fila.length;
    log.info('fila do Google Play: ' + fila.length + ' elegiveis | fora: ' + JSON.stringify(motivos));
    for (const livro of fila.slice(0, decisao.vagas)) {
      try {
        const x = await publicarUm(page, db, livro, { seco });
        if (x.publicado) r.publicados++;
        r.ultimo = x.id;
      } catch (e) {
        if (/^GPLAY_SEM_SESSAO/.test(e.message)) throw e;
        r.falhas++;
        evento(db, livro.id, livro.gplay_id || null, 'falha', e.message);
        log.error('FALHA livro ' + livro.id.slice(0, 8) + ': ' + umaLinha(e.message, 240));
      }
    }
    return r;
  } catch (e) {
    if (!/^GPLAY_SEM_SESSAO/.test(e.message)) throw e;
    // Nao e falha do livro: o rascunho fica, e a proxima rodada retoma.
    log.warn('GPLAY_SEM_SESSAO: o Google pede login — entrar em https://navegador.veloxisit.com.br (conta do Partner Center)');
    return { ...r, semSessao: true };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
    soltar();
  }
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); console.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { prepararBanco, candidatos, principal, AJUDA };
