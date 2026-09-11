# manter_capas.ps1 - vigia do passe de capas virais.
#
# O passe leva ~2 dias e roda NESTA maquina (a sessao do Hotmart esta presa a
# origem: so funciona no Chrome 9223 daqui). Como filho de um terminal, ele
# morria em silencio se a sessao fechasse ou a maquina reiniciasse.
#
# Rodado pelo Agendador a cada 15 min:
#   - passe vivo            -> nao faz nada
#   - passe morto           -> religa, destacado do terminal
#   - catalogo terminado    -> remove a propria tarefa agendada (nao fica lixo)
#
# O passe e idempotente: religar retoma de onde parou, sem refazer o que ja
# subiu (tabelas cover_viral_v2 e cover_backfill no VPS).

$ErrorActionPreference = 'Continue'
$raiz   = 'C:\Users\m_rov\ClaudeProjects\EbookPublisher'
$log    = Join-Path $raiz 'logs\capas_viral.log'
$vigia  = Join-Path $raiz 'logs\manter_capas.log'
$tarefa = 'GENIA-CapasVirais'

New-Item -ItemType Directory -Force -Path (Join-Path $raiz 'logs') | Out-Null
function Registrar($msg) {
  Add-Content -Path $vigia -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding utf8
}

# Fim legitimo: o proprio orquestrador escreve esta linha quando nao ha mais
# e-book sem capa viral. Qualquer outro fim (queda) deve ser religado.
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'catalogo inteiro com capa viral' -Quiet)) {
  Registrar 'catalogo terminado - removendo a tarefa agendada'
  schtasks /Delete /TN $tarefa /F | Out-Null
  exit 0
}

$vivo = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*capas_ate_acabar*' }
if ($vivo) { exit 0 }

# Chrome 9223 fora do ar: religar o passe so geraria falha de sessao. Registra
# e espera a proxima rodada - quem abre o Chrome e loga e o usuario.
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  Registrar 'Chrome 9223 fora do ar - passe nao religado (abra o Chrome de automacao e logue no Hotmart)'
  exit 0
}

Registrar 'passe morto - religando'
# cmd /c com >> ACRESCENTA ao log. Start-Process -RedirectStandardOutput
# sobrescreveria o arquivo a cada religamento e apagaria o historico dos ciclos.
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', 'node scripts\capas_ate_acabar.js --lote=40 --ciclos=2000 >> logs\capas_viral.log 2>&1' `
  -WorkingDirectory $raiz `
  -WindowStyle Hidden
