#!/usr/bin/env node
/**
 * Migra console.log/error/warn/info para o logger winston em todos os arquivos JS
 * que ainda usam console.* mas não têm logger importado.
 *
 * Uso: node scripts/migrate-console-to-logger.js [--dry-run]
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DRY_RUN  = process.argv.includes('--dry-run');
const ROOT_DIR = path.join(__dirname, '..');

// Arquivos/pastas a ignorar
const IGNORE_DIRS  = new Set(['node_modules', '.git', 'logs', 'data', 'scripts', 'dist', 'public']);
const IGNORE_FILES = new Set(['logger.js', 'migrate-console-to-logger.js']);

// Mapeamento console → nível winston
const LEVEL_MAP = { log: 'info', error: 'error', warn: 'warn', info: 'info', debug: 'debug' };

let totalFiles = 0;
let patchedFiles = 0;
const skipped = [];
const errors  = [];

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !IGNORE_FILES.has(entry.name)) {
      processFile(full);
    }
  }
}

function processFile(filePath) {
  totalFiles++;
  let src;
  try { src = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { errors.push(`${filePath}: leitura falhou — ${e.message}`); return; }

  // Verifica se há console.* que vale migrar
  const consolePattern = /console\.(log|error|warn|info|debug)\s*\(/;
  if (!consolePattern.test(src)) return;

  // Já tem logger? Só substitui as chamadas, não adiciona import
  const hasLoggerImport = /require.*logger/.test(src) || /createLogger/.test(src);

  // Calcula caminho relativo de volta para src/core/logger
  const loggerAbs  = path.join(ROOT_DIR, 'src', 'core', 'logger.js');
  const fileDir    = path.dirname(filePath);
  let   relLogger  = path.relative(fileDir, loggerAbs).replace(/\\/g, '/');
  if (!relLogger.startsWith('.')) relLogger = './' + relLogger;
  // Remove extensão .js
  relLogger = relLogger.replace(/\.js$/, '');

  // Nome do módulo = nome do arquivo sem extensão
  const moduleName = path.basename(filePath, '.js');

  // Substitui console.<level>( → logger.<level>(
  let modified = src;
  for (const [cons, level] of Object.entries(LEVEL_MAP)) {
    const re = new RegExp(`console\\.${cons}\\s*\\(`, 'g');
    modified = modified.replace(re, `logger.${level}(`);
  }

  if (modified === src) { skipped.push(filePath); return; }

  if (!hasLoggerImport) {
    // Insere import logo após 'use strict' / require('dotenv') / primeira linha de require, ou no topo
    const importLine = `const { createLogger } = require('${relLogger}');\nconst logger = createLogger('${moduleName}');\n`;
    // Tenta inserir após a primeira linha de require ou 'use strict'
    const insertAfter = /^(['"]use strict['"];?\n|require\([^)]+\);\n)/m;
    const match = insertAfter.exec(modified);
    if (match) {
      const pos = match.index + match[0].length;
      modified = modified.slice(0, pos) + importLine + modified.slice(pos);
    } else {
      modified = importLine + modified;
    }
  }

  if (DRY_RUN) {
    console.log(`[DRY] Patching: ${path.relative(ROOT_DIR, filePath)}`);
    patchedFiles++;
    return;
  }

  try {
    // Escrita atômica via temp file
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, modified, 'utf8');
    fs.renameSync(tmp, filePath);
    console.log(`[OK] ${path.relative(ROOT_DIR, filePath)}`);
    patchedFiles++;
  } catch (e) {
    errors.push(`${filePath}: escrita falhou — ${e.message}`);
  }
}

walkDir(path.join(ROOT_DIR, 'src'));

console.log('\n─────────────────────────────────────────');
console.log(`Total arquivos JS verificados : ${totalFiles}`);
console.log(`Arquivos migrados             : ${patchedFiles}`);
console.log(`Skipped (sem console.*)       : ${skipped.length}`);
if (errors.length) {
  console.log(`\nERROS (${errors.length}):`);
  errors.forEach(e => console.log('  ' + e));
}
console.log('─────────────────────────────────────────');
if (DRY_RUN) console.log('Modo DRY-RUN — nenhum arquivo foi alterado.');
