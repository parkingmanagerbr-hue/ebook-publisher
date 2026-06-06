#!/usr/bin/env node
/**
 * setup-cakto.js — Exporta sessão do Chrome para uso autônomo no Cakto
 *
 * Uso:
 *   node scripts/setup-cakto.js
 *
 * Não precisa fazer login novamente — exporta a sessão do Chrome que já está logado.
 * Se não estiver logado, o script guia você pelo processo.
 */
const path     = require('path');
const fs       = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, '../data/sessions/cakto.json');
fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  CAKTO — Exportar Sessão do Chrome (one-time setup)');
  console.log('═'.repeat(65));

  if (fs.existsSync(SESSION_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const savedAt  = existing.savedAt ? new Date(existing.savedAt).toLocaleString('pt-BR') : 'desconhecido';
      const cookies  = (existing.cookies || []).length;
      console.log(`\n⚠️  Sessão existente encontrada:`);
      console.log(`   Salva em: ${savedAt}`);
      console.log(`   Cookies:  ${cookies}`);
      const overwrite = await prompt('\nDeseja substituir por uma nova sessão? (s/N): ');
      if (!overwrite.toLowerCase().startsWith('s')) {
        console.log('\n✅ Sessão mantida. Setup cancelado.');
        process.exit(0);
      }
    } catch (_) {}
  }

  console.log('\nVocê já está logado no Cakto no Chrome. Vamos exportar essa sessão.');
  console.log('\n📋 PASSOS:');
  console.log('  1. Abra o Chrome e vá para: https://app.cakto.com.br/dashboard');
  console.log('     (Se pedir login, faça login primeiro e volte aqui)');
  console.log('  2. Pressione F12 para abrir o DevTools');
  console.log('  3. Clique na aba "Console"');
  console.log('  4. Cole e execute este código:\n');

  const snippet = `
(function(){
  var cookies = document.cookie.split(';').map(function(c){
    var p=c.trim().split('=');
    return {name:p[0],value:p.slice(1).join('='),domain:'.cakto.com.br',path:'/'};
  });
  var ls={};
  for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);ls[k]=localStorage.getItem(k);}
  var ss={};
  for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);ss[k]=sessionStorage.getItem(k);}
  var result=JSON.stringify({cookies:cookies,localStorage:ls,sessionStorage:ss,url:location.href,savedAt:Date.now()});
  console.log('CAKTO_SESSION_START');
  console.log(result);
  console.log('CAKTO_SESSION_END');
})();`.trim();

  console.log('─'.repeat(65));
  console.log(snippet);
  console.log('─'.repeat(65));
  console.log('\n  5. Copie o JSON que aparecer entre CAKTO_SESSION_START e END');
  console.log('  6. Cole aqui abaixo e pressione ENTER duas vezes:\n');

  let captured = '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise(resolve => {
    let inside = false;
    let emptyCount = 0;

    rl.on('line', line => {
      if (line.includes('CAKTO_SESSION_START')) { inside = true; return; }
      if (line.includes('CAKTO_SESSION_END'))   { inside = false; resolve(); return; }
      if (inside) { captured += line; return; }

      // Sem delimitadores — aceitar JSON puro colado diretamente
      if (line.trim().startsWith('{')) { captured += line.trim(); }
      else if (line.trim() === '') {
        emptyCount++;
        if (emptyCount >= 2 && captured.length > 10) resolve();
      } else {
        captured += line.trim();
      }
    });

    rl.on('close', resolve);
  });

  if (!captured.trim()) {
    console.error('\n❌ Nenhum JSON recebido. Tente novamente.');
    process.exit(1);
  }

  let session;
  try {
    // Remover possível saída extra do console (linhas antes do JSON)
    const jsonStart = captured.indexOf('{');
    const jsonEnd   = captured.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('JSON não encontrado');
    session = JSON.parse(captured.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    console.error('\n❌ JSON inválido:', e.message);
    console.error('   Recebido:', captured.slice(0, 200));
    process.exit(1);
  }

  // Validar sessão
  const cookies = session.cookies || [];
  const hasAuthCookie = cookies.some(c =>
    c.name && (
      c.name.toLowerCase().includes('session') ||
      c.name.toLowerCase().includes('token')   ||
      c.name.toLowerCase().includes('auth')    ||
      c.name.toLowerCase().includes('jwt')
    )
  );
  const hasToken = session.localStorage && (
    session.localStorage['token'] ||
    session.localStorage['auth_token'] ||
    session.localStorage['@cakto:token']
  );

  if (!hasAuthCookie && !hasToken) {
    console.warn('\n⚠️  Aviso: nenhum cookie de autenticação encontrado.');
    console.warn('   Certifique-se de estar logado no Cakto antes de exportar.');
    const cont = await prompt('Continuar mesmo assim? (s/N): ');
    if (!cont.toLowerCase().startsWith('s')) {
      console.log('Setup cancelado.');
      process.exit(1);
    }
  }

  // Salvar
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, savedAt: Date.now() }, null, 2));
  console.log('\n✅ Sessão Cakto salva com sucesso!');
  console.log(`   Arquivo: ${SESSION_FILE}`);
  console.log(`   Cookies: ${cookies.length}`);
  console.log(`   Token localStorage: ${hasToken ? '✓' : '–'}`);
  console.log('\n🚀 O agente usará esta sessão para publicar automaticamente no Cakto.');
  console.log('   A sessão é válida por ~7 dias. Repita o setup quando expirar.\n');
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
