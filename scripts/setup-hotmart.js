#!/usr/bin/env node
/**
 * setup-hotmart.js — Exporta sessão do Chrome para uso autônomo
 *
 * Uso:
 *   node scripts/setup-hotmart.js
 *
 * Não precisa fazer login novamente — exporta a sessão do Chrome que já está logado.
 */
const path    = require('path');
const fs      = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, '../data/sessions/hotmart.json');
fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  HOTMART — Exportar Sessão do Chrome (one-time setup)');
  console.log('═'.repeat(65));
  console.log('\nVocê já está logado na Hotmart no Chrome. Vamos exportar essa sessão.');
  console.log('\n📋 PASSOS:');
  console.log('  1. Abra o Chrome e vá para: https://app-vlc.hotmart.com/products');
  console.log('  2. Pressione F12 para abrir o DevTools');
  console.log('  3. Clique na aba "Console"');
  console.log('  4. Cole e execute este código:\n');

  const snippet = `
(function(){
  var cookies = document.cookie.split(';').map(function(c){
    var p=c.trim().split('=');
    return {name:p[0],value:p.slice(1).join('='),domain:'.hotmart.com',path:'/'};
  });
  var ls={};
  for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);ls[k]=localStorage.getItem(k);}
  var ss={};
  for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);ss[k]=sessionStorage.getItem(k);}
  var result=JSON.stringify({cookies:cookies,localStorage:ls,sessionStorage:ss,url:location.href,savedAt:Date.now()});
  console.log('HOTMART_SESSION_START');
  console.log(result);
  console.log('HOTMART_SESSION_END');
})();`.trim();

  console.log('─'.repeat(65));
  console.log(snippet);
  console.log('─'.repeat(65));
  console.log('\n  5. Copie o JSON que aparecer entre HOTMART_SESSION_START e END');
  console.log('  6. Cole aqui abaixo e pressione ENTER duas vezes:\n');

  let jsonLines = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise(resolve => {
    let capturing = false;
    let captured = '';
    console.log('Cole o JSON aqui:');
    rl.on('line', line => {
      if (line.includes('HOTMART_SESSION_START')) { capturing = true; return; }
      if (line.includes('HOTMART_SESSION_END'))   { capturing = false; rl.close(); resolve(); return; }
      if (capturing) { captured += line; return; }
      // Sem marcadores — aceitar linha direta
      if (!capturing && line.trim().startsWith('{')) { captured += line; }
      if (!capturing && line.trim() === '' && captured) { rl.close(); resolve(); }
    });
    rl.on('close', resolve);
  });

  // Tentar parsear
  let session;
  try {
    const raw = jsonLines.join('') || (() => {
      // Ler stdin acumulado
      try { return require('fs').readFileSync('/dev/stdin', 'utf8'); } catch { return '{}'; }
    })();
    session = JSON.parse(raw);
  } catch {
    // Tentar ler o que foi capturado pelo readline
    console.error('\n❌ Não foi possível parsear o JSON. Tente novamente.');
    process.exit(1);
  }

  session.savedAtHuman = new Date().toLocaleString('pt-BR');
  session.cookieCount  = (session.cookies || []).length;

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

  console.log('\n' + '═'.repeat(65));
  console.log('✅ Sessão Hotmart salva!');
  console.log(`   Cookies: ${session.cookieCount}`);
  console.log(`   localStorage: ${Object.keys(session.localStorage || {}).length} keys`);
  console.log(`   Arquivo: ${SESSION_FILE}`);
  console.log('\nPara ativar publicação automática, adicione ao .env:');
  console.log('   AUTO_PUBLISH_HOTMART=true');
  console.log('═'.repeat(65) + '\n');
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
