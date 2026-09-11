# manter_capas.ps1 - vigia do passe de capas virais.
#
# O passe leva ~2 dias e roda NESTA maquina (a sessao do Hotmart esta presa a
# origem: so funciona no Chrome 9223 daqui). Como filho de um terminal, ele
# morria em silencio se a sessao fechasse ou a maquina reiniciasse.
#
# Rodado pelo Agendador a cada 15 min, nesta ordem:
#   1. catalogo terminado   -> remove a propria tarefa agendada (nao fica lixo)
#   2. Chrome 9223 fora     -> registra e sai (sem ele nada funciona)
#   3. token do servidor    -> renova a cada 6 h, com o passe vivo OU morto
#   4. passe vivo           -> sai
#   5. passe morto          -> religa, destacado do terminal
#
# A renovacao vem ANTES do teste de "passe vivo" de proposito: o passe esta vivo
# quase sempre, e com a ordem invertida o vigia sairia antes de renovar.
#
# O passe e idempotente: religar retoma de onde parou, sem refazer o que ja
# subiu (tabelas cover_viral_v2 e cover_backfill no VPS).

$ErrorActionPreference = 'Continue'
$raiz   = 'C:\Users\m_rov\ClaudeProjects\EbookPublisher'
$log    = Join-Path $raiz 'logs\capas_viral.log'
$vigia  = Join-Path $raiz 'logs\manter_capas.log'
$marca  = Join-Path $raiz 'logs\token_renovado.txt'
$tarefa = 'GENIA-CapasVirais'

New-Item -ItemType Directory -Force -Path (Join-Path $raiz 'logs') | Out-Null

# Uma execucao do vigia por vez. Visto em 11/09/2026: o agendamento disparou no
# mesmo segundo de uma execucao manual e os dois renovaram o token. Se os dois
# tivessem achado o passe morto, subiriam DOIS orquestradores processando os
# mesmos livros. O segundo a chegar simplesmente sai.
$trava = New-Object System.Threading.Mutex($false, 'Global\GENIA-CapasVirais-Vigia')
if (-not $trava.WaitOne(0)) { exit 0 }

function Registrar($msg) {
  Add-Content -Path $vigia -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding utf8
}

# 1. Fim legitimo: o proprio orquestrador escreve esta linha quando nao ha mais
#    e-book sem capa viral. Qualquer outro fim (queda) deve ser religado.
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'catalogo inteiro com capa viral' -Quiet)) {
  Registrar 'catalogo terminado - removendo a tarefa agendada'
  schtasks /Delete /TN $tarefa /F | Out-Null
  exit 0
}

# 2. Sem o Chrome de automacao nada funciona: nem upload nem renovacao de token.
#    Quem abre o Chrome e loga no Hotmart e o usuario.
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  Registrar 'Chrome 9223 fora do ar - abra o Chrome de automacao e logue no Hotmart'
  exit 0
}

# 3. Token do servidor (Bearer) dura ~1,5 dia e so pode ser renovado AQUI: o CAS
#    recusa o TGT vindo do VPS. Venceu uma vez sem ninguem ver (10/09) e a
#    finalizacao de rascunhos parou.
$precisa = -not (Test-Path $marca) -or ((Get-Date) - (Get-Item $marca).LastWriteTime).TotalHours -ge 6
if ($precisa) {
  $saida = & cmd /c "cd /d $raiz && node scripts\renovar_token_local.js 2>&1"
  if ($saida -match 'token instalado') {
    Set-Content -Path $marca -Value (Get-Date -Format s) -Encoding utf8
    Registrar ('token renovado: ' + (($saida | Select-String 'valido ate') -join ''))
  } else {
    Registrar ('falha ao renovar token: ' + (($saida | Select-Object -Last 1) -join ''))
  }
}

# 4. Passe vivo: nada a fazer.
$vivo = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*capas_ate_acabar*' }
if ($vivo) { exit 0 }

# 5. Passe morto: religar. cmd /c com >> ACRESCENTA ao log; Start-Process
#    -RedirectStandardOutput sobrescreveria o arquivo e apagaria os ciclos.
Registrar 'passe morto - religando'
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', 'node scripts\capas_ate_acabar.js --lote=40 --ciclos=2000 >> logs\capas_viral.log 2>&1' `
  -WorkingDirectory $raiz `
  -WindowStyle Hidden
