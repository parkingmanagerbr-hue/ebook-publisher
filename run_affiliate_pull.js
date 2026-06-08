require('dotenv').config({ path: __dirname + '/.env' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { runAffiliateAgent, getAffiliateLinks } = require('./src/agents/affiliateAgent');
// força rodar ignorando o intervalo de 24h
const fs = require('fs'); const path=require('path');
try { fs.unlinkSync(path.join(__dirname,'data','db','affiliate_last_run.txt')); } catch(_){}
(async () => {
  await runAffiliateAgent();
  for (const p of ['hotmart','cakto','amazon']) {
    const rows = getAffiliateLinks(p);
    console.log(`\n=== ${p}: ${rows.length} com link de afiliado ===`);
    rows.slice(0,5).forEach(r => console.log(' -', r.product_name.slice(0,45), '=>', (r.affiliate_link||'').slice(0,60)));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
