/**
 * publisherHotmart.js — GENIA E-book Publisher
 */
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/app/data/landing_screenshots';
const DEFAULT_PRICE = process.env.HOTMART_PRICE || '4,99';
let log;
try { const L = require('../core/Logger'); log = L.createLogger ? L.createLogger('hotmart') : console; } catch(e) { log = { info: (...a) => console.log('[hotmart]', ...a), warn: (...a) => console.warn('[hotmart]', ...a), error: (...a) => console.error('[hotmart]', ...a) }; }
const TECH_KW = ['web3','blockchain','programar','chatbot','cloud','saas','tecnologia','inteligencia artificial',' ia ','python','javascript','codigo','algoritmo','digital','nft','criptomoeda','linux','docker'];
const HEALTH_KW = ['saude','sono','depressao','panico','menopausa','hipertrofia','pressao','alcalina','alimentac','dieta','emagrecimento','fitness','exercicio','musculacao','mental','ansiedade','yoga','meditacao','hormonio','diabetes','colesterol'];
const FINANCE_KW = ['investimento','financ','dinheiro','consorcio','franquia','airbnb','freelancer','renda','patrimonio','aposentadoria','acoes','fundo','bitcoin','trading','bolsa','credito','emprestimo'];
const BUSINESS_KW = ['nomade','negocio','empreend','carreira','marketing','vendas','produtividade','lideranca','gestao','startup','cliente','lucro','estrategia','branding','copywriting','persona'];
function norm(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
function getCategoryPT(title, topic) {
  const t = norm(title + ' ' + (topic||''));
  if (TECH_KW.some(k => t.includes(k)))     return 'Tecnologia e Programação';
  if (HEALTH_KW.some(k => t.includes(k)))   return 'Saúde e Esportes';
  if (FINANCE_KW.some(k => t.includes(k)))  return 'Negócios e Carreira';
  if (BUSINESS_KW.some(k => t.includes(k))) return 'Negócios e Carreira';
  return 'Desenvolvimento Pessoal';
}
function getCASTicket(tgt, serviceUrl) {
  return new Promise((resolve, reject) => {
    const body = 'service=' + encodeURIComponent(serviceUrl);
    const opts = { hostname: 'sso.hotmart.com', path: '/v1/tickets/' + tgt, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/plain', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d.trim()})); });
    req.on('error',reject); req.write(body); req.end();
  });
}
async function refreshJWT(browser, session) {
  const hmSso = session.cookies.find(c => c.name === 'hmSsoExp');
  if (!hmSso) throw new Error('hmSsoExp cookie not found');
  const tgt = hmSso.value.split('|').slice(1).join('|');
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d&scope=openid+profile+email&redirect_uri=https%3A%2F%2Fapp.hotmart.com%2Flogout&response_type=code';
  const st = await getCASTicket(tgt, oauth2Service);
  log.info('CAS ST:', st.status);
  const lp = await browser.newPage();
  for (const c of session.cookies) {
    try { const x={...c}; delete x.sameSite; delete x.sameParty; if(x.expires===-1)delete x.expires; if(!x.url)x.url=x.domain&&x.domain.startsWith('.')?'https://'+x.domain.slice(1):'https://'+(x.domain||'hotmart.com'); await lp.setCookie(x); } catch(e) {}
  }
  try { await lp.goto(oauth2Service+'&ticket='+st.body,{waitUntil:'networkidle2',timeout:30000}); } catch(e) {}
  await sleep(6000);
  const tok = await lp.evaluate(()=>localStorage.getItem('token')).catch(()=>null);
  log.info('JWT:', tok ? 'OK' : 'MISSING');
  await lp.close();
  return tok;
}
async function setupPage(page, session, jwt) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});});
  const ls = {...(session.localStorage||{})}; if(jwt) ls.token=jwt;
  await page.evaluateOnNewDocument((ls)=>{Object.entries(ls).forEach(([k,v])=>{try{localStorage.setItem(k,v);}catch{}});}, ls);
  for (const c of session.cookies) {
    try { const x={...c}; delete x.sameSite; delete x.sameParty; if(x.expires===-1)delete x.expires; if(!x.url)x.url=x.domain&&x.domain.startsWith('.')?'https://'+x.domain.slice(1):'https://'+(x.domain||'hotmart.com'); await page.setCookie(x); } catch(e) {}
  }
}
async function waitForDDP(page, minLen, maxSec) {
  for (let i=0; i<maxSec; i++) {
    await sleep(1000);
    const len = await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.length:0).catch(()=>0);
    if(i%5===4) log.info('DDP t='+(i+1)+'s len='+len);
    if(len>=minLen){log.info('DDP ready t='+(i+1)+'s'); return len;}
  }
  return 0;
}
async function createProduct(page, session, ebook) {
  const { title, description, coverPath, pdfPath, topic } = ebook;
  const category = getCategoryPT(title, topic);
  log.info('Creating: '+JSON.stringify(title)+' => '+category);
  await page.goto('https://app.hotmart.com/products/add/4/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await waitForDDP(page, 500, 20);
  let nameInput = null;
  for(let i=0;i<20;i++){
    await sleep(1000);
    nameInput = await page.$('input#name,input[name="name"],input[placeholder*="nome"],input[placeholder*="produto"]').catch(()=>null);
    if(nameInput) break;
  }
  if(!nameInput) nameInput = await page.$('input[type="text"]').catch(()=>null);
  if(!nameInput) throw new Error('Name input not found');
  await nameInput.click({clickCount:3});
  await nameInput.type(title,{delay:30});
  await sleep(500);
  const descInput = await page.$('textarea#description,textarea[name="description"],textarea[placeholder*="descri"]').catch(()=>null);
  if(descInput){ await descInput.click({clickCount:3}); await descInput.type(description||title,{delay:10}); await sleep(300); }
  if(coverPath && fs.existsSync(coverPath)){
    const fi = await page.$('input[type="file"]').catch(()=>null);
    if(fi){ await fi.uploadFile(coverPath); await sleep(3000); }
  }
  const catClicked = await page.evaluate((cat)=>{
    const all = Array.from(document.querySelectorAll('button,[class*="categor"],[class*="card"]'));
    const b = all.find(b=>b.textContent.trim()===cat||b.textContent.includes(cat.split(' ')[0]));
    if(b){b.click();return true;} return false;
  }, category);
  log.info('Category clicked: '+catClicked);
  await sleep(800);
  await page.evaluate(()=>{const s=document.querySelectorAll('[class*="subcategor"] button,[class*="subcategor"]');if(s.length>0)s[0].click();});
  await sleep(500);
  let capturedNumericId=null, capturedUcode=null;
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  client.on('Network.responseReceived', async(evt)=>{
    const u=evt.response.url;
    if((u.includes('vulcano')||u.includes('hotmart'))&&evt.response.status===200&&(u.includes('/product'))){
      try{const rb=await client.send('Network.getResponseBody',{requestId:evt.requestId}).catch(()=>null);
        if(rb){const d=JSON.parse(rb.body);if(d.id)capturedNumericId=String(d.id);if(d.ucode)capturedUcode=d.ucode;}
      }catch(e){}
    }
  });
  const contClicked = await page.evaluate(()=>{
    const b=Array.from(document.querySelectorAll('button')).find(b=>{const t=b.textContent.trim().toLowerCase();return t==='continuar'||t==='next'||t==='salvar e continuar';});
    if(b){b.click();return b.textContent.trim();} return false;
  });
  log.info('Continuar: '+contClicked);
  await sleep(4000);
  await waitForDDP(page, 300, 10);
  await page.evaluate((n,v)=>{const s=document.querySelector('hot-select[name="'+n+'"]')||document.querySelector('[name="'+n+'"]');if(s){s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));}},'currency','BRL');
  await sleep(300);
  await page.evaluate((n,v)=>{const s=document.querySelector('hot-select[name="'+n+'"]')||document.querySelector('[name="'+n+'"]');if(s){s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));}},'paymentMode','PAY_IN_FULL');
  await sleep(300);
  const priceInput = await page.$('input[name="price"],input[placeholder*="valor"],input[type="number"]').catch(()=>null);
  if(priceInput){await priceInput.click({clickCount:3});await priceInput.type(DEFAULT_PRICE,{delay:50});}
  else{await page.keyboard.press('Tab');await sleep(200);await page.keyboard.type(DEFAULT_PRICE,{delay:50});}
  await sleep(300);
  const saveClicked = await page.evaluate(()=>{
    const b=Array.from(document.querySelectorAll('button[type="submit"],button')).find(b=>{const t=b.textContent.trim().toLowerCase();return t==='salvar'||t==='criar produto'||t==='criar'||t==='finalizar';});
    if(b){b.click();return b.textContent.trim();} return false;
  });
  log.info('Save: '+saveClicked);
  await sleep(6000);
  let numericId=capturedNumericId;
  const urlM=page.url().match(/\/products\/manage\/(\d+)/);
  if(urlM) numericId=urlM[1];
  if(!numericId && capturedUcode){
    const token=await page.evaluate(()=>localStorage.getItem('token')).catch(()=>null);
    if(token){try{const resp=await page.evaluate(async(tok)=>{const r=await fetch('https://api-product.vulcano.hotmart.com/product/v1/user/product/list?max=200&page=0',{headers:{'Authorization':'Bearer '+tok}});return r.json();},token);const item=(resp.items||[]).find(x=>x.ucode===capturedUcode);if(item)numericId=String(item.id);}catch(e){}}
  }
  await client.detach().catch(()=>{});
  log.info('numericId='+numericId);
  return { numericId, category };
}
async function uploadPDF(page, numericId, pdfPath) {
  log.info('Uploading PDF to '+numericId);
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await waitForDDP(page, 1200, 40);
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Painel');if(b)b.click();});
  await sleep(3000);
  let configs=[];
  for(let i=0;i<20;i++){
    await sleep(1000);
    configs=await page.evaluate(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Configurar').map(b=>{const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,vis:r.width>0};}).filter(b=>b.vis));
    if(configs.length>0){log.info('Configurar at t='+(i+1)+'s');break;}
  }
  if(!configs.length){log.warn('No Configurar');return false;}
  const cfg=configs.find(c=>c.y<700)||configs[0];
  await page.mouse.click(cfg.x,cfg.y);
  await sleep(4000);
  for(let att=0;att<3;att++){
    const inp=await page.$('input[type="file"]').catch(()=>null);
    if(inp){log.info('File input found!');await inp.uploadFile(pdfPath);await sleep(15000);return true;}
    const bi=await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['selecione','upload','enviar','arquivo','escolher'].some(k=>(b.textContent||'').toLowerCase().includes(k)));if(b){const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:r.left+r.width/2,y:r.top+r.height/2};}return null;});
    if(bi){log.info('Clicking "'+bi.text+'"');await page.mouse.click(bi.x,bi.y);await sleep(2000);const i2=await page.$('input[type="file"]').catch(()=>null);if(i2){log.info('Input appeared!');await i2.uploadFile(pdfPath);await sleep(15000);return true;}}
    await sleep(3000);
  }
  log.warn('Upload failed');return false;
}
async function finalizarCadastro(page, numericId) {
  log.info('Finalizing '+numericId);
  await page.goto('https://app.hotmart.com/products/manage/'+numericId+'/info',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await waitForDDP(page, 1200, 40);
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Painel');if(b)b.click();});
  let fInfo=null;
  for(let i=0;i<30;i++){
    await sleep(1000);
    fInfo=await page.evaluate(()=>{const btn=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Finalizar cadastro');if(!btn)return null;const r=btn.getBoundingClientRect();return{disabled:btn.disabled,x:r.left+r.width/2,y:r.top+r.height/2};}).catch(()=>null);
    if(fInfo){log.info('Finalizar t='+(i+1)+'s disabled='+fInfo.disabled);break;}
  }
  if(!fInfo){log.warn('Finalizar not found');return false;}
  if(fInfo.disabled){log.warn('Finalizar disabled');return false;}
  await page.mouse.click(fInfo.x,fInfo.y);
  await sleep(5000);
  await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['confirmar','sim','ok','publicar','finalizar','ativar'].includes((b.textContent||'').trim().toLowerCase()));if(b)b.click();});
  await sleep(4000);
  const after=await page.evaluate(()=>document.body&&document.body.innerText?document.body.innerText.slice(0,200):'').catch(()=>'');
  log.info('After: '+after.replace(/\n/g,' ').slice(0,100));
  return true;
}
async function screenshotSalesPage(page, numericId, title) {
  try {
    const st=title.replace(/[^a-zA-Z0-9]/g,'_').slice(0,40);
    const outPath=path.join(SCREENSHOTS_DIR,numericId+'_'+st+'.png');
    fs.mkdirSync(SCREENSHOTS_DIR,{recursive:true});
    await page.goto('https://pay.hotmart.com/product/'+numericId,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await sleep(3000);
    await page.screenshot({path:outPath,fullPage:false});
    log.info('Screenshot: '+outPath);
    return outPath;
  }catch(e){log.warn('Screenshot failed: '+e.message);return null;}
}
async function publishToHotmart(ebook) {
  const { title, topic, pdfPath, coverPath, description } = ebook;
  if(!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: '+SESSION_FILE);
  if(!pdfPath||!fs.existsSync(pdfPath)) throw new Error('PDF not found: '+pdfPath);
  const session=JSON.parse(fs.readFileSync(SESSION_FILE,'utf8'));
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process'],defaultViewport:{width:1280,height:900}});
  try {
    const jwt=await refreshJWT(browser,session);
    const page=await browser.newPage();
    await setupPage(page,session,jwt);
    page.on('framenavigated',f=>{if(f===page.mainFrame())log.info('NAV',f.url().slice(0,90));});
    await page.goto('https://app.hotmart.com/products/producer',{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
    await sleep(5000);
    const {numericId,category}=await createProduct(page,session,{title,topic,description,coverPath,pdfPath});
    if(!numericId) throw new Error('No product ID after creation');
    const uploaded=await uploadPDF(page,numericId,pdfPath);
    if(!uploaded) log.warn('PDF upload failed');
    const finalized=await finalizarCadastro(page,numericId);
    const screenshot=await screenshotSalesPage(page,numericId,title);
    await browser.close();
    log.info('Done: '+title+' id='+numericId+' ok='+finalized);
    return{success:finalized,hotmartProductId:numericId,url:'https://hotmart.com/product/'+numericId,screenshot,category,platform:'hotmart',uploaded};
  }catch(err){
    await browser.close().catch(()=>{});
    log.error('Error: '+err.message);
    throw err;
  }
}
module.exports = { publishToHotmart, getCategory: getCategoryPT };