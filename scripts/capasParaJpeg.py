"""capasParaJpeg.py — converte as capas PNG dos livros para JPEG e libera disco.

08/10/2026: as capas ocupavam 23 GB (PNG de ~1,6 MB cada) com o disco da VPS em
95%. JPEG de qualidade 88 tem a mesma aparencia em ~1/5 do tamanho.

Ordem que nao perde capa:
  1. converte para um TEMPORARIO e confere (abre de novo, mesmas dimensoes, > 10 KB)
  2. renomeia o temporario para o .jpg final (falha no meio nao deixa meio arquivo)
  3. aponta TODO livro que usava o PNG para o JPEG (commit)
  4. so entao apaga o PNG
Capa mexida na ultima hora e pulada (pode estar sendo usada por uma publicacao).

Uso (no container):
  python3 scripts/capasParaJpeg.py                     # relatorio
  python3 scripts/capasParaJpeg.py --aplicar --limite=1
"""
import os
import sqlite3
import sys
import time

from PIL import Image

DB = os.environ.get('METRICS_DB', '/app/data/metrics.db')
QUALIDADE = 88
RECENTE_S = 3600


def arg(nome, padrao):
    for a in sys.argv[1:]:
        if a.startswith('--' + nome + '='):
            return a.split('=', 1)[1]
    return padrao


def converter(png, agora=None):
    """Converte um PNG. Devolve (jpg, bytes_economizados) ou lanca. Nao toca o banco."""
    agora = agora or time.time()
    if not os.path.isfile(png):
        raise FileNotFoundError('sumiu: ' + png)
    if agora - os.path.getmtime(png) < RECENTE_S:
        raise RuntimeError('recente')
    jpg = os.path.splitext(png)[0] + '.jpg'
    if os.path.exists(jpg):
        raise FileExistsError('ja existe: ' + jpg)
    tmp = jpg + '.tmp'
    with Image.open(png) as im:
        largura, altura = im.size
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            fundo = Image.new('RGB', im.size, (255, 255, 255))
            fundo.paste(im, mask=im.split()[-1])
            im = fundo
        elif im.mode != 'RGB':
            im = im.convert('RGB')
        im.save(tmp, 'JPEG', quality=QUALIDADE, optimize=True, progressive=True)
    try:
        with Image.open(tmp) as conf:
            conf.load()
            if conf.size != (largura, altura):
                raise RuntimeError('dimensao mudou')
        if os.path.getsize(tmp) < 10 * 1024:
            raise RuntimeError('jpeg pequeno demais')
    except Exception:
        os.remove(tmp)
        raise
    os.replace(tmp, jpg)
    return jpg, os.path.getsize(png) - os.path.getsize(jpg)


def main():
    aplicar = '--aplicar' in sys.argv
    limite = int(arg('limite', '1000000'))
    db = sqlite3.connect(DB, timeout=30)
    db.execute('PRAGMA busy_timeout = 30000')
    pngs = [r[0] for r in db.execute(
        "SELECT DISTINCT cover_path FROM ebooks WHERE cover_path LIKE '%.png'").fetchall()]
    existentes = [p for p in pngs if os.path.isfile(p)]
    total = sum(os.path.getsize(p) for p in existentes)
    print('capas png referenciadas: %d (existem %d, %.1f GB)' % (len(pngs), len(existentes), total / 1e9), flush=True)
    if not aplicar:
        return
    feitas = falhas = puladas = 0
    economia = 0
    for png in existentes[:limite]:
        try:
            jpg, eco = converter(png)
        except RuntimeError as e:
            if str(e) == 'recente':
                puladas += 1
                continue
            falhas += 1
            print('falha %s: %s' % (os.path.basename(png), e), flush=True)
            continue
        except (FileExistsError, FileNotFoundError, OSError) as e:
            falhas += 1
            print('falha %s: %s' % (os.path.basename(png), e), flush=True)
            continue
        with db:
            db.execute('UPDATE ebooks SET cover_path = ? WHERE cover_path = ?', (jpg, png))
        os.remove(png)
        feitas += 1
        economia += eco
        if feitas % 500 == 0:
            print('convertidas %d, economia %.1f GB' % (feitas, economia / 1e9), flush=True)
    print('resumo: {"feitas": %d, "falhas": %d, "puladas_recentes": %d, "economia_gb": %.2f}'
          % (feitas, falhas, puladas, economia / 1e9), flush=True)


if __name__ == '__main__':
    main()
