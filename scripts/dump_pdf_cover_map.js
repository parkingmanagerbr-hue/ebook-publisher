// roda no container: gera /app/data/pdf_cover_map.json = { "ebook_X.pdf": "/app/data/covers/..._kdp.jpg" }
const D = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = new D('/app/data/metrics.db');
const rows = db.prepare("SELECT pdf_path, cover_path FROM ebooks WHERE pdf_path IS NOT NULL AND cover_path IS NOT NULL").all();
const map = {};
for (const r of rows) {
  const pdf = path.basename(r.pdf_path || '');
  if (!pdf) continue;
  let cover = r.cover_path;
  if (!fs.existsSync(cover)) { // tenta o basename em /app/data/covers
    const c2 = '/app/data/covers/' + path.basename(cover);
    if (fs.existsSync(c2)) cover = c2; else continue;
  }
  const jpg = cover.replace(/\.[^.]+$/, '') + '_kdp.jpg';
  if (!fs.existsSync(jpg) || fs.statSync(jpg).size === 0) {
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', cover, '-vf',
        'scale=1600:2560:force_original_aspect_ratio=decrease,pad=1600:2560:(ow-iw)/2:(oh-ih)/2:black', '-q:v', '2', jpg]);
    } catch (e) { continue; }
  }
  if (fs.existsSync(jpg) && fs.statSync(jpg).size > 0) map[pdf] = jpg;
}
fs.writeFileSync('/app/data/pdf_cover_map.json', JSON.stringify(map));
console.log('map entries:', Object.keys(map).length);
