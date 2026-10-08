'use strict';
/**
 * capasParaJpeg.py: converte, aponta o livro para o JPEG e so entao apaga o PNG;
 * capa recente fica (pode estar em uso). Roda o script de verdade, com banco e
 * pasta temporarios. Precisa de Python com Pillow (o mesmo da capa do KDP).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const PY = process.env.PYTHON || (spawnSync('python3', ['-c', 'import PIL']).status === 0 ? 'python3' : 'python');
const temPil = spawnSync(PY, ['-c', 'import PIL']).status === 0;

test('converte PNG antigo, aponta o livro e apaga o PNG; PNG recente fica', { skip: !temPil && 'sem Pillow' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capas-jpeg-'));
  const velho = path.join(dir, 'velha.png');
  const novo = path.join(dir, 'nova.png');
  // PNG de verdade (com ruido, para o JPEG passar dos 10 KB), gerado pelo proprio Pillow
  execFileSync(PY, ['-c',
    'import sys,random\nfrom PIL import Image\nim=Image.new("RGBA",(400,640))\n' +
    'im.putdata([(random.randrange(256),random.randrange(256),random.randrange(256),255) for _ in range(400*640)])\n' +
    'im.save(sys.argv[1]); im.save(sys.argv[2])', velho, novo]);
  const antigo = Date.now() / 1000 - 7200;
  fs.utimesSync(velho, antigo, antigo);
  const dbPath = path.join(dir, 'm.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ebooks (id TEXT, cover_path TEXT)');
  db.prepare('INSERT INTO ebooks VALUES (?,?)').run('a', velho);
  db.prepare('INSERT INTO ebooks VALUES (?,?)').run('b', velho); // dois livros, mesma capa
  db.prepare('INSERT INTO ebooks VALUES (?,?)').run('c', novo);
  db.close();

  const saida = execFileSync(PY, [path.join(__dirname, '..', 'scripts', 'capasParaJpeg.py'), '--aplicar'],
    { env: { ...process.env, METRICS_DB: dbPath }, encoding: 'utf8' });
  assert.match(saida, /"feitas": 1/);
  assert.match(saida, /"puladas_recentes": 1/);

  const jpg = path.join(dir, 'velha.jpg');
  assert.ok(fs.existsSync(jpg), 'jpeg criado');
  assert.ok(!fs.existsSync(velho), 'png antigo apagado');
  assert.ok(fs.existsSync(novo), 'png recente preservado');
  const db2 = new Database(dbPath, { readonly: true });
  const rows = db2.prepare('SELECT id, cover_path FROM ebooks ORDER BY id').all();
  db2.close();
  assert.deepStrictEqual(rows.map(r => [r.id, path.basename(r.cover_path)]), [['a', 'velha.jpg'], ['b', 'velha.jpg'], ['c', 'nova.png']]);
  const cabeca = fs.readFileSync(jpg).subarray(0, 2);
  assert.deepStrictEqual([...cabeca], [0xFF, 0xD8]);
});
