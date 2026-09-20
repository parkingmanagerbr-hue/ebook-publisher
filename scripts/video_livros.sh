#!/bin/sh
# Video vertical 1080x1920 com 6 capas dos livros em destaque (2,5 s cada).
#
# Layout (16/09/2026): textos na faixa de cima (15%-45% da altura) e capa
# embaixo. Com a capa no meio e o endereco no rodape, o Guard 0 do ClipCaster
# (legenda_duplicada: texto claro da faixa inferior / faixa de referencia)
# mediu 13,6x e cancelou o post nas tres redes.
set -e
D=/app/landing_pages/livros/img
F=/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf
OUT=${OUT:-/tmp/promo-livros.mp4}
# IDS pela variavel: o rodizio tem 3 anuncios de livros (promo-livros,
# promo-livros-2, promo-livros-3), cada um com capas diferentes — com um so,
# a vitrine ia ao ar uma vez a cada 3 ou 4 dias (medido em 20/09/2026).
set -- ${IDS:-8451111 8451425 8450880 8482824 8448400 8482735}
ARGS=""; FILT=""; i=0
for id in "$@"; do
  ARGS="$ARGS -loop 1 -t 2.5 -i $D/$id.jpg"
  FILT="$FILT[$i:v]scale=600:-2,pad=1080:1920:(ow-iw)/2:880:color=0x0e0e1a,setsar=1,fps=30,format=yuv420p[v$i];"
  i=$((i+1))
done
CONCAT=""; j=0; while [ $j -lt $i ]; do CONCAT="$CONCAT[v$j]"; j=$((j+1)); done
TITULO=${TITULO:-Livros digitais práticos}
TXT="drawtext=fontfile=$F:text='$TITULO':fontsize=64:fontcolor=white:x=(w-tw)/2:y=360,drawtext=fontfile=$F:text='Dinheiro, carreira e produtividade':fontsize=40:fontcolor=0xffcf5a:x=(w-tw)/2:y=500,drawtext=fontfile=$F:text='veloxisit.com.br/livros':fontsize=56:fontcolor=0xff6a3d:x=(w-tw)/2:y=640"
ffmpeg -y -loglevel error $ARGS -filter_complex "${FILT}${CONCAT}concat=n=$i:v=1:a=0,$TXT[out]" -map "[out]" -c:v libx264 -preset veryfast -crf 23 -movflags +faststart $OUT
ffprobe -v error -show_entries format=duration:stream=width,height -of csv=p=0 $OUT
