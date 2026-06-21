#!/usr/bin/env bash
# batch_covers_to_jpeg.sh — converte todas as capas PNG -> JPEG no padrão KDP
# (1600x2560, 1.6:1, padding preto preservando a arte). Idempotente: pula as que já têm _kdp.jpg.
# Rodar DENTRO do container: docker exec platform-ebook-publisher-1 bash /app/scripts/batch_covers_to_jpeg.sh
set -uo pipefail
DIR=/app/data/covers
ok=0; skip=0; fail=0; total=0

for png in "$DIR"/cover*.png; do
  [ -e "$png" ] || continue
  total=$((total+1))
  jpg="${png%.png}_kdp.jpg"
  if [ -s "$jpg" ]; then skip=$((skip+1)); continue; fi
  if ffmpeg -y -loglevel error -i "$png" \
       -vf "scale=1600:2560:force_original_aspect_ratio=decrease,pad=1600:2560:(ow-iw)/2:(oh-ih)/2:black" \
       -q:v 2 "$jpg" </dev/null; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "FALHA: $png"
  fi
done

echo "=== TOTAL=$total | convertidas=$ok | ja_tinha=$skip | falhas=$fail ==="
echo "exemplos:"; ls -1 "$DIR"/*_kdp.jpg 2>/dev/null | head -3
