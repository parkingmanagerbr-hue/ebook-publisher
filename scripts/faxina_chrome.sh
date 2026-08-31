#!/bin/sh
# Roda DENTRO do container. Mata chromium orfao mais velho que LIMITE_MIN.
LIMITE_MIN=${LIMITE_MIN:-40}
LIM=$((LIMITE_MIN * 60))
antes=$(ps -eo comm | grep -c chrom)
ps -eo pid,etimes,comm | awk -v lim="$LIM" '$3 ~ /chrom/ && $2 > lim { print $1 }' > /tmp/matar.txt
n=$(wc -l < /tmp/matar.txt)
[ "$n" -gt 0 ] && xargs -r kill -9 < /tmp/matar.txt 2>/dev/null
sleep 1
depois=$(ps -eo comm | grep -c chrom)
echo "chromium: $antes -> $depois (mortos $n com mais de ${LIMITE_MIN}min)"
