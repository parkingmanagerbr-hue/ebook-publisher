#!/bin/sh
# Video vertical 1080x1920 com 6 capas dos livros em destaque (2,5 s cada).
set -e
D=/app/landing_pages/livros/img
F=/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf
OUT=/tmp/promo-livros.mp4
set -- 8451111 8451425 8450880 8482824 8448400 8482735
ARGS=""; FILT=""; i=0
for id in "$@"; do
  ARGS="$ARGS -loop 1 -t 2.5 -i $D/$id.jpg"
  FILT="$FILT[$i:v]scale=820:-2,pad=1080:1920:(ow-iw)/2:330:color=0x0e0e1a,setsar=1,fps=30,format=yuv420p[v$i];"
  i=$((i+1))
done
CONCAT=""; j=0; while [ $j -lt $i ]; do CONCAT="$CONCAT[v$j]"; j=$((j+1)); done
TXT="drawtext=fontfile=$F:text='Livros digitais práticos':fontsize=76:fontcolor=white:x=(w-tw)/2:y=150,drawtext=fontfile=$F:text='Dinheiro, carreira e produtividade':fontsize=44:fontcolor=0xffcf5a:x=(w-tw)/2:y=250,drawtext=fontfile=$F:text='veloxisit.com.br/livros':fontsize=64:fontcolor=white:box=1:boxcolor=0xff6a3d:boxborderw=24:x=(w-tw)/2:y=1700"
ffmpeg -y -loglevel error $ARGS -filter_complex "${FILT}${CONCAT}concat=n=$i:v=1:a=0,$TXT[out]" -map "[out]" -c:v libx264 -preset veryfast -crf 23 -movflags +faststart $OUT
ffprobe -v error -show_entries format=duration:stream=width,height -of csv=p=0 $OUT
