const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs   = require('fs');

const logsDir = path.join(__dirname, '../../logs');
try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function createLogger(module) {
  return winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta: { module },
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, module, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, module, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `[${timestamp}] ${level} [${module}] ${message}${metaStr}`;
          })
        )
      }),
      new winston.transports.DailyRotateFile({
        dirname: logsDir,
        filename: 'combined-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '5d'
      }),
      new winston.transports.DailyRotateFile({
        dirname: logsDir,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxSize: '10m',
        maxFiles: '14d'
      })
    ]
  });
}

// Logger dedicado para requisições HTTP — grava em access-DATE.log
const _accessLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, message }) => `[${timestamp}] ${message}`)
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname: logsDir,
      filename: 'access-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '7d'
    })
  ]
});

/**
 * Caminho para o log de acesso, sem o que nao pode ser registrado.
 *
 * A URL vem do usuario: quebra de linha nela forjaria uma linha inteira de log,
 * e a query string carrega token de download e e-mail de comprador. Fica so o
 * caminho, com marca de que havia query. Puro.
 */
function caminhoSeguro(url) {
  const cru = String(url == null ? '' : url).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const [caminho, query] = cru.split('?');
  return (caminho.trim() || '/').slice(0, 200) + (query !== undefined ? '?…' : '');
}

/** IP sem o ultimo octeto (LGPD): serve para diagnostico, nao identifica. Puro. */
function ipMascarado(ip) {
  const s = String(ip == null ? '' : ip).split(',')[0].trim().replace(/[^0-9a-fA-F.:]/g, '');
  if (!s) return '-';
  const v4 = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return v4[1] + '.0';
  if (!s.includes(':')) return '-';
  return s.split(':').slice(0, 3).join(':') + '::';
}

/** Linha do log de acesso. Pura, para poder ser testada de verdade. */
function linhaDeAcesso({ method, url, status, ms, ip }) {
  return (String(method || '').replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() || '-') + ' ' +
    caminhoSeguro(url) + ' ' + (Number(status) || 0) + ' ' + (Number(ms) || 0) + 'ms ip=' + ipMascarado(ip);
}

// Express middleware: loga METHOD /path status ms
function httpLoggerMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const dados = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip || (req.headers && req.headers['x-forwarded-for']),
    };
    _accessLogger.info(linhaDeAcesso(dados));
    // Erros 4xx/5xx também vão para combined log
    if (res.statusCode >= 400) {
      createLogger('http').warn(linhaDeAcesso(dados));
    }
  });
  next();
}

module.exports = { createLogger, httpLoggerMiddleware, linhaDeAcesso, caminhoSeguro, ipMascarado };
