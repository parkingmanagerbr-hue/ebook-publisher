'use strict';
/**
 * capasExternasHotmart.js — capa para os produtos que estao no Hotmart mas nao
 * no nosso banco.
 *
 * Medido em 18/09/2026: 147 produtos ATIVOS sem imagem de capa. Nenhum deles
 * esta na tabela ebooks (sao de maio/junho, de antes do pipeline atual). 134
 * tem arquivo e entregam normalmente — so aparecem sem capa no marketplace e
 * no checkout; os outros 13 foram pausados por nao entregar nada.
 *
 * Aqui so a GERACAO da capa (no container, onde ha fonte e gerador de imagem).
 * O envio e local, porque a chamada de foto da Hotmart precisa sair de dentro
 * da pagina logada: scripts/capas_em_lote.js le a tabela capa_externa.
 *
 * Uso (no container): node scripts/capasExternasHotmart.js --limite=5
 */
const fs = require('fs');

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/** Palpite de idioma pelo titulo: so pt e en, que e o que aparece na lista. Pura. */
function idiomaDoTitulo(titulo) {
  const t = String(titulo || '');
  if (/[ãõçáéíóúâêô]/i.test(t)) return 'pt-BR';
  if (/\b(the|your|how|money|wealth|guide|master|profit|income|business|health)\b/i.test(t)) return 'en-US';
  return 'pt-BR';
}

async function main() {
  const limite = parseInt(arg('limite', '5'), 10);
  const db = require('../src/core/database').getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS capa_externa (produto TEXT PRIMARY KEY, title TEXT, cover_path TEXT, language TEXT, quando INTEGER)').run();

  const { baixarCatalogo } = require('../src/agents/hotmartCatalogo');
  const { consultarConteudo } = require('../src/agents/hotmartConteudo');
  const tok = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();

  const catalogo = await baixarCatalogo(tok);
  const noBanco = new Set(db.prepare("SELECT CAST(hotmart_product_id AS TEXT) p FROM ebooks WHERE hotmart_product_id <> ''").all().map(r => r.p));
  const feitos = new Set(db.prepare('SELECT produto FROM capa_externa').all().map(r => r.produto));
  const pausados = new Set(db.prepare('SELECT produto FROM hotmart_pausados').all().map(r => r.produto));

  const alvos = catalogo.filter(x =>
    x.status === 'ACTIVE' && !x.urlCoverPhoto && x.format === 1 &&
    !noBanco.has(String(x.id)) && !feitos.has(String(x.id)) && !pausados.has(String(x.id)));

  const { generateViralCover } = require('../src/agents/coverViralAgent');
  const { getCategoryPT } = require('../src/agents/hotmartRegras');
  const COVERS = process.env.COVERS_DIR || '/app/data/covers';
  const grava = db.prepare('INSERT OR REPLACE INTO capa_externa VALUES (?,?,?,?,?)');
  let ok = 0, falha = 0, semArquivo = 0;

  for (const x of alvos.slice(0, limite)) {
    // Produto que nao entrega nao ganha capa: primeiro o arquivo.
    if (await consultarConteudo(x.id, { token: tok }) !== true) { semArquivo++; continue; }
    const idioma = idiomaDoTitulo(x.name);
    try {
      const caminho = await generateViralCover(x.name, '', x.name, getCategoryPT(x.name, ''), COVERS, idioma, { exigirImagemUnica: true });
      if (!caminho || !fs.existsSync(caminho)) throw new Error('gerador nao devolveu arquivo');
      grava.run(String(x.id), x.name, caminho, idioma, Date.now());
      ok++;
      console.log('OK ' + x.id + ' ' + String(x.name).slice(0, 45));
    } catch (e) {
      falha++;
      console.log('FALHA ' + x.id + ': ' + String(e.message).slice(0, 90));
    }
  }
  console.log(JSON.stringify({ candidatos: alvos.length, ok, falha, semArquivo }));
}

module.exports = { idiomaDoTitulo };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
