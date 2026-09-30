# -*- coding: utf-8 -*-
"""
capaKdp.py — capa do KDP com o titulo EXATO do cadastro e o nome do autor.

Por que existe (30/09/2026): a capa das outras lojas traz um titulo-gancho
("COMA BEM EM QUALQUER TURNO") diferente do titulo do livro ("Low-Carb para
Quem Vive em Turnos"). A Amazon exige que o titulo da capa bata com o do
cadastro, e o autor do cadastro (John Brooks) nao aparecia em lugar nenhum.
Esta capa reaproveita a FOTO da capa existente — so a faixa sem texto — e
escreve titulo, subtitulo e autor por cima de um degrade escuro. Nada de selo
ou promessa ("resultados reais"): so o que e do proprio livro.

Uso: python capaKdp.py <capa_origem> <saida.jpg> "<titulo>" "<subtitulo>" "<autor>"
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

L, A = 1600, 2560                      # proporcao 1:1,6 que o KDP recomenda
FONTES = ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
FONTES_LEVES = ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf',
                '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']


def fonte(lista, tamanho):
    for f in lista:
        if os.path.exists(f):
            return ImageFont.truetype(f, tamanho)
    return ImageFont.load_default()


def quebrar(desenho, texto, f, largura):
    """Quebra em linhas que cabem na largura. Palavra maior que a linha fica sozinha."""
    linhas, atual = [], ''
    for p in str(texto or '').split():
        teste = (atual + ' ' + p).strip()
        if desenho.textlength(teste, font=f) <= largura or not atual:
            atual = teste
        else:
            linhas.append(atual)
            atual = p
    if atual:
        linhas.append(atual)
    return linhas


def titulo_que_cabe(desenho, texto, largura, maximo_linhas=4):
    """Maior fonte em que o titulo cabe em ate N linhas."""
    for tam in range(150, 60, -6):
        f = fonte(FONTES, tam)
        linhas = quebrar(desenho, texto, f, largura)
        if len(linhas) <= maximo_linhas:
            return f, linhas, tam
    f = fonte(FONTES, 60)
    return f, quebrar(desenho, texto, f, largura), 60


def montar(origem, saida, titulo, subtitulo, autor):
    foto = Image.open(origem).convert('RGB')
    w, h = foto.size
    # Faixa da foto sem texto embutido: tira ~9% do topo (frase-gancho) e
    # fica acima da faixa de titulo das capas geradas (~60% da altura).
    topo, base = int(h * 0.09), int(h * 0.60)
    faixa = foto.crop((0, topo, w, base))
    alvo_h = int(A * 0.62)
    escala = max(L / faixa.width, alvo_h / faixa.height)
    faixa = faixa.resize((int(faixa.width * escala), int(faixa.height * escala)), Image.LANCZOS)
    x0 = (faixa.width - L) // 2
    faixa = faixa.crop((x0, 0, x0 + L, alvo_h))

    capa = Image.new('RGB', (L, A), (12, 14, 20))
    capa.paste(faixa, (0, 0))
    # degrade da foto para o fundo escuro, para o texto ter contraste
    degrade = Image.new('L', (1, 520))
    for y in range(520):
        degrade.putpixel((0, y), int(255 * (y / 519) ** 1.4))
    mascara = degrade.resize((L, 520))
    fundo = Image.new('RGB', (L, 520), (12, 14, 20))
    capa.paste(fundo, (0, alvo_h - 520), mascara)

    d = ImageDraw.Draw(capa)
    margem = 110
    largura = L - 2 * margem
    f_tit, linhas, tam = titulo_que_cabe(d, titulo.upper(), largura)
    y = alvo_h - 120
    for ln in linhas:
        d.text((L // 2, y), ln, font=f_tit, fill=(255, 255, 255), anchor='ma')
        y += int(tam * 1.08)
    y += 30
    d.rectangle((L // 2 - 70, y, L // 2 + 70, y + 8), fill=(255, 190, 150))
    y += 60
    f_sub = fonte(FONTES_LEVES, 58)
    for ln in quebrar(d, subtitulo, f_sub, largura)[:3]:
        d.text((L // 2, y), ln, font=f_sub, fill=(225, 228, 235), anchor='ma')
        y += 76
    f_aut = fonte(FONTES, 64)
    d.text((L // 2, A - 190), autor, font=f_aut, fill=(255, 255, 255), anchor='ma')

    tmp = saida + '.tmp.jpg'
    capa.save(tmp, 'JPEG', quality=90)
    os.replace(tmp, saida)       # temporario + replace: falha no meio nao deixa meia capa
    return len(linhas)


if __name__ == '__main__':
    if len(sys.argv) != 6:
        print(__doc__)
        sys.exit(2)
    n = montar(*sys.argv[1:6])
    print('capa KDP gerada: ' + sys.argv[2] + ' (' + str(n) + ' linha(s) de titulo)')
