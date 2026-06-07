'use strict';
/**
 * capture-hotmart-session.js
 * Opens a visible Hotmart browser window.
 * You log in manually. When login is detected, session is auto-saved.
 * Run: node scripts/capture-hotmart-session.js
 */
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const SESSION_FILE = path.resolve(__dirname, '../data/sessions/hotmart.json');

(async () => {
  console.log('🚀 Opening Hotmart login page...');
  console.log('👤 Log in with your credentials in the browser window that opens.');
  console.log('✅ Session will be saved automatically after login.\n');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  await page.goto('https://app.hotmart.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('⏳ Waiting for you to log in... (checking every 3s)');
  let saved = false;

  // Poll until we detect a token in localStorage (= logged in)
  while (!saved) {
    await new Promise(r => setTimeout(r, 3000));

    try {
      const token = await page.evaluate(() =>
        localStorage.getItem('token') ||
        localStorage.getItem('access_token') ||
        localStorage.getItem('@hotmart:token') || ''
      ).catch(() => '');

      if (!token) continue;

      // Check JWT not expired
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          if (Date.now() / 1000 > payload.exp) {
            console.log('   Token found but still expired, waiting...');
            continue;
          }
          console.log(`\n✅ Logged in! JWT sub=${payload.sub} email=${payload.email}`);
          console.log(`   Token expires: ${new Date(payload.exp * 1000).toISOString()}`);
        }
      } catch (_) {}

      // Capture cookies + localStorage
      const cookies     = await page.cookies();
      const localStorage_ = await page.evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      });

      const session = { cookies, localStorage: localStorage_, capturedAt: new Date().toISOString() };

      // Ensure directory exists
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
      console.log(`\n💾 Session saved to: ${SESSION_FILE}`);
      console.log(`   Cookies: ${cookies.length}`);
      console.log(`   localStorage keys: ${Object.keys(localStorage_).length}`);

      const hmSso = cookies.find(c => c.name === 'hmSsoExp');
      if (hmSso) {
        console.log(`   ✅ hmSsoExp (CAS TGT) found — auto-refresh will work!`);
      } else {
        console.log(`   ⚠️  hmSsoExp not found — session won't auto-refresh (normal for Google SSO)`);
      }

      saved = true;
    } catch (e) {
      // page navigating, retry
    }
  }

  console.log('\n🎉 Done! You can close the browser.');
  await browser.close();

  console.log('\n📤 Now upload to VPS with:');
  console.log('   ssh vps "docker exec -i platform-ebook-publisher-1 sh -c \'cat > /app/data/sessions/hotmart.json\'" < data/sessions/hotmart.json');
  console.log('   (run from EbookPublisher root)');
})();
