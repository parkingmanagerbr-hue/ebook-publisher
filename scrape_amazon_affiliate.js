process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const puppeteer=require('puppeteer'); const fs=require('fs');
const TAG='pride2026-20';
const KEYWORDS=['air fryer','fone bluetooth','smartwatch','aspirador robo','cafeteira','liquidificador','panela eletrica','echo dot','webcam','caixa de som bluetooth'];
const hires=u=>u.replace(/\._[^.]+_\./,'.'); // remove size modifier -> full-res
(async()=>{
  const sess=JSON.parse(fs.readFileSync('data/sessions/amazon.json','utf8'));
  const b=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox','--disable-blink-features=AutomationControlled']});
  const p=await b.newPage();
  await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  for(const c of (sess.cookies||[])){try{const x={...c};delete x.sameSite;if(x.expires===-1)delete x.expires;if(!x.url)x.url='https://'+(x.domain||'amazon.com.br').replace(/^\./,'');await p.setCookie(x);}catch(_){}}
  const all=[]; const seen=new Set();
  for(const kw of KEYWORDS){
    await p.goto('https://www.amazon.com.br/s?k='+encodeURIComponent(kw),{waitUntil:'domcontentloaded',timeout:40000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,2500+Math.random()*1500));
    const prods=await p.evaluate(()=>{
      const out=[];
      document.querySelectorAll('div[data-asin]').forEach(d=>{
        const asin=d.getAttribute('data-asin'); if(!asin||asin.length!==10)return;
        const t=d.querySelector('h2 span,.a-size-medium,.a-size-base-plus');
        const img=d.querySelector('img.s-image');
        const price=d.querySelector('.a-price .a-offscreen');
        if(t&&img)out.push({asin,name:t.textContent.trim(),img:img.src,price:price?price.textContent.trim():''});
      });
      return out.slice(0,6);
    });
    for(const x of prods){
      if(seen.has(x.asin)||!x.price)continue; seen.add(x.asin);
      const cents=Math.round(parseFloat(x.price.replace(/[^0-9,]/g,'').replace(',','.'))*100)||0;
      all.push({category:kw, asin:x.asin, name:x.name.slice(0,90), price_cents:cents,
        image_url:hires(x.img), affiliate_link:`https://www.amazon.com.br/dp/${x.asin}?tag=${TAG}`});
    }
    console.log(kw,'->',prods.length);
  }
  fs.writeFileSync('amazon_products.json',JSON.stringify(all,null,2));
  console.log('TOTAL:',all.length,'-> amazon_products.json');
  await b.close();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
