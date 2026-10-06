'use strict';
/**
 * capas_kiwify.js — poe capa (e categoria) nos produtos da Kiwify.
 *
 * Roda na MAQUINA DO LOGIN da Kiwify (Chrome de automacao), como o
 * publicar_kiwify: a API do painel exige a sessao da aba. As capas moram no VPS
 * e vem em lote (um tar por rodada, nao um scp por livro: o sshd da VPS
 * estrangula conexoes novas).
 *
 * Cada produto so conta como feito quando a API devolve product_img preenchido.
 * Progresso em logs/kiwify_capas.jsonl (uma linha por produto).
 *
 * Uso:
 *   node scripts/capas_kiwify.js --limite=1                 # teste
 *   node scripts/capas_kiwify.js --limite=200
 *   node scripts/capas_kiwify.js --forcar=<id1>,<id2>       # capa errada: troca
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { urlCdpObrigatoria } = require('../src/core/cdpLocal');
const { credenciais, chamar } = require('../src/agents/publisherKiwify');
const { filaDeCapas, aplicarNoPainel } = require('../src/agents/kiwifyCapa');
let log;
try { log = require('../src/core/logger').createLogger('capasKiwify'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const { noServidor, rodarAqui, pastaDeTrabalho } = require('../src/core/modoServidor');
// Na VPS a pasta e a compartilhada com o Chrome: o upload passa o caminho.
const TMP = pastaDeTrabalho('capas-kiwify');
// Cada produto recarrega o painel, e cada recarga renova o login (getIdToken).
// 70 seguidos em 06/10/2026 e a Kiwify passou a recusar a renovacao: pagina
// em branco para todo o resto. Pausa entre produtos e parada depois de 3
// paginas que nao carregam (em vez de queimar a fila inteira com erro).
const PAUSA_MS = parseInt(process.env.KIWIFY_CAPA_PAUSA_MS || '20000', 10);
const MAX_SEM_PAINEL = 3;
const dormir = ms => new Promise(r => setTimeout(r, ms));
// Na VPS o progresso fica em data/ (sobrevive ao deploy, que recria o container).
const PROGRESSO = noServidor() ? '/app/data/kiwify_capas.jsonl' : path.join(__dirname, '..', 'logs', 'kiwify_capas.jsonl');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : p; };
const umaLinha = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const chaveNome = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Livros do banco da VPS ligados a Kiwify: por id do produto e por nome unico. */
function livrosDoServidor() {
  const js = "const D=require('better-sqlite3');const db=new D('/app/data/metrics.db',{readonly:true});" +
    "console.log(JSON.stringify(db.prepare(\"SELECT kiwify_product_id pid, title, topic, cover_path FROM ebooks WHERE cover_path IS NOT NULL AND cover_path <> ''\").all()))";
  const saida = noServidor()
    ? rodarAqui(js)
    : execFileSync('ssh', ['-o', 'ConnectTimeout=30', VPS, 'docker exec ' + CONTAINER + ' node -e "' + js.replace(/"/g, '\\"') + '"'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(saida.slice(saida.indexOf('[')));
}

function mapaDeLivros(linhas, produtos) {
  const porId = new Map();
  for (const l of linhas) if (l.pid) porId.set(l.pid, l);
  // Nome unico como reserva, para produto cujo id nao ficou gravado no banco.
  const porNome = new Map();
  for (const l of linhas) { const k = chaveNome(l.title); porNome.set(k, porNome.has(k) ? null : l); }
  const mapa = new Map();
  for (const p of produtos) {
    const l = porId.get(p.id) || porNome.get(chaveNome(p.name)) || null;
    if (l) mapa.set(p.id, l);
  }
  return mapa;
}

/** Baixa as capas da fila num tar so. Devolve id -> caminho local. */
function baixarCapas(fila) {
  fs.mkdirSync(TMP, { recursive: true });
  if (noServidor()) {
    // Na VPS a capa ja esta no disco: copia para a pasta que o Chrome enxerga.
    const mapa = new Map();
    for (const i of fila) {
      const destino = path.join(TMP, i.id + path.extname(i.capa || '.png'));
      try { fs.copyFileSync(i.capa, destino); if (fs.statSync(destino).size > 1000) mapa.set(i.id, destino); }
      catch (_) { /* protocolo: capa ausente fica fora do mapa e vira "sem-capa" */ }
    }
    return mapa;
  }
  const caminhos = [...new Set(fila.map(i => i.capa))];
  const tar = path.join(TMP, 'lote.tar');
  const fd = fs.openSync(tar, 'w');
  // A lista vai pela ENTRADA do tar (-T -), nao pela linha de comando: 746
  // caminhos passaram do limite de ~32 mil caracteres do Windows e o comando
  // chegou cortado na VPS (06/10/2026).
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=30', VPS, 'docker exec -i ' + CONTAINER + ' tar -cf - -T -'],
    { input: caminhos.join('\n') + '\n', stdio: ['pipe', fd, 'pipe'], timeout: 900000 });
  fs.closeSync(fd);
  if (r.status !== 0 && !(fs.statSync(tar).size > 0)) throw new Error('tar das capas falhou: ' + umaLinha(r.stderr, 200));
  // tar cortado pode deixar a ULTIMA capa pela metade: o bloco inteiro fica
  // para a proxima rodada em vez de subir imagem quebrada.
  fs.rmSync(path.join(TMP, 'app'), { recursive: true, force: true });
  execFileSync('tar', ['-xf', 'lote.tar'], { cwd: TMP, timeout: 300000, stdio: 'ignore' });
  const mapa = new Map();
  for (const i of fila) {
    const local = path.join(TMP, i.capa.replace(/^\//, ''));
    if (fs.existsSync(local) && fs.statSync(local).size > 1000) mapa.set(i.id, local);
  }
  return mapa;
}

function lerFeitos() {
  const feitos = new Set();
  if (!fs.existsSync(PROGRESSO)) return feitos;
  for (const l of fs.readFileSync(PROGRESSO, 'utf8').split('\n')) {
    try { const o = JSON.parse(l); if (o.resultado === 'ok') feitos.add(o.id); } catch (_) { /* protocolo: linha vazia ou cortada */ }
  }
  return feitos;
}

function registrar(o) {
  fs.mkdirSync(path.dirname(PROGRESSO), { recursive: true });
  fs.appendFileSync(PROGRESSO, JSON.stringify({ ...o, quando: new Date().toISOString() }) + '\n');
}

async function principal() {
  const limite = Number(arg('limite', '50')) || 50;
  const forcar = new Set(String(arg('forcar', '')).split(',').map(s => s.trim()).filter(Boolean));
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: await urlCdpObrigatoria(), defaultViewport: { width: 1400, height: 1000 } });
  const page = await browser.newPage();
  const resumo = { fila: 0, ok: 0, falhas: 0, semCapa: 0, categorias: 0, moedaTrocada: 0, moedaConfirmada: 0 };
  const convertidos = new Map();
  try {
    const cred = await credenciais(page);
    const lista = await chamar(page, cred, 'GET', '/v1/products', null);
    const produtos = Array.isArray(lista.json) ? lista.json : (lista.json && (lista.json.data || lista.json.products)) || [];
    if (!produtos.length) throw new Error('listagem da Kiwify vazia (status ' + lista.status + ')');
    const livros = mapaDeLivros(livrosDoServidor(), produtos);
    const fila = filaDeCapas(produtos, livros, { feitos: lerFeitos(), forcar, limite, converterMoeda: process.argv.includes('--converter-moeda') });
    resumo.fila = fila.length;
    log.info('produtos ' + produtos.length + ', sem imagem ' + produtos.filter(p => !p.product_img).length + ', ligados a livro ' + livros.size + ', fila ' + fila.length);
    if (!fila.length) return resumo;
    // Capas em blocos de 40: um tar de 746 capas (centenas de MB) chegou cortado
    // quando o container reiniciou no meio, e a rodada inteira morreu (06/10/2026).
    let capas = new Map();
    let parar = false;
    let semPainel = 0;
    for (let ini = 0; ini < fila.length && !parar; ini += 40) {
    const bloco = fila.slice(ini, ini + 40);
    try { capas = baixarCapas(bloco); } catch (e) { log.warn('bloco de capas falhou: ' + umaLinha(e.message, 160)); capas = new Map(); }
    for (const item of bloco) {
      const local = capas.get(item.id);
      if (!local) { resumo.semCapa++; registrar({ id: item.id, resultado: 'sem-capa' }); continue; }
      try {
        const feito = await aplicarNoPainel(page, { ...item, capa: local }, { log });
        // Conferencia pela API: so conta o que ficou gravado.
        const d = await chamar(page, cred, 'GET', '/v1/products/' + item.id + '?full=true', null);
        const pr = (d.json && d.json.product) || {};
        // Troca de moeda: o painel tem de ter ENVIADO a moeda e o preco pedidos.
        if (item.moeda && !(feito.moeda === item.moeda.moeda && feito.preco === item.moeda.centavos)) {
          throw new Error('KIWIFY_MOEDA: o painel salvou ' + feito.moeda + ' ' + feito.preco + ' em vez de ' + item.moeda.moeda + ' ' + item.moeda.centavos);
        }
        if (item.moeda) { resumo.moedaTrocada++; convertidos.set(item.id, item.moeda); }
        if (pr.product_img && (!feito.imagem || pr.product_img === feito.imagem)) {
          resumo.ok++;
          if (feito.categoria != null && pr.category === feito.categoria) resumo.categorias++;
          registrar({ id: item.id, resultado: 'ok', categoria: pr.category });
          log.info('capa ok: ' + umaLinha(item.nome, 50) + ' | categoria ' + pr.category);
        } else {
          resumo.falhas++;
          registrar({ id: item.id, resultado: 'nao-gravou' });
          log.warn('painel salvou mas a API nao mostra a imagem: ' + umaLinha(item.nome, 50));
        }
      } catch (e) {
        resumo.falhas++;
        registrar({ id: item.id, resultado: 'erro', erro: umaLinha(e.message, 160) });
        log.error('falha ' + umaLinha(item.nome, 50) + ': ' + umaLinha(e.message, 160));
        if (/KIWIFY_LIMITE|SEM_SESSAO/.test(e.message)) { parar = true; break; } // a conta toda parou: nao insistir
        // Tres falhas SEGUIDAS de qualquer tipo = a Kiwify esta recusando o ritmo
        // (pagina em branco ou salvar sem resposta): para e deixa para a proxima.
        if (++semPainel >= MAX_SEM_PAINEL) {
          log.warn('Kiwify falhou ' + semPainel + ' vezes seguidas — paro a rodada; a fila continua na proxima');
          parar = true; break;
        }
        await dormir(PAUSA_MS);
        continue;
      }
      semPainel = 0;
      await dormir(PAUSA_MS);
    }
    }
    // Conferencia final da moeda pela listagem (o GET do produto nao traz moeda).
    if (convertidos.size) {
      const depois = await chamar(page, cred, 'GET', '/v1/products', null);
      const lista2 = Array.isArray(depois.json) ? depois.json : (depois.json && (depois.json.data || depois.json.products)) || [];
      for (const q of lista2) {
        const m = convertidos.get(q.id);
        if (!m) continue;
        if (q.currency === m.moeda && Number(q.price) === m.centavos) resumo.moedaConfirmada++;
        else log.warn('moeda nao confirmada pela API: ' + umaLinha(q.name, 50) + ' esta em ' + q.currency + ' ' + q.price);
      }
    }
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
  return resumo;
}

if (require.main === module) {
  // Um por vez: a tarefa agendada (de 30 em 30 min) e um lote grande lancado a
  // mao subiriam a mesma capa no mesmo produto.
  const soltar = require('../src/core/travaLocal').travar('kiwify-capas', { oQue: 'capas_kiwify --limite=' + arg('limite', '?'), avisar: m => console.log(m) });
  if (!soltar) { console.log('ja existe uma rodada de capas da Kiwify em andamento — saindo'); process.exit(0); }
  const fim = codigo => { soltar(); process.exit(codigo); };
  process.on('SIGINT', () => fim(130));
  process.on('SIGTERM', () => fim(143));
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); fim(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); fim(1); });
}

module.exports = { principal, mapaDeLivros };
