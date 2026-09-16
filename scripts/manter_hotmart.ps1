$ErrorActionPreference = 'Continue'
# manter_hotmart.ps1 - manutencao local permanente da Hotmart (tarefa GENIA-Hotmart, a cada 30 min).
#
# O vigia das capas (manter_capas.ps1) renovava o token da Hotmart e se apagava
# quando o passe terminava. Em 16/09/2026 o passe acabou de madrugada e o token do
# servidor ficou a poucas horas de vencer - afiliacao, vendas e conferencia de
# conteudo dependem dele. Esta tarefa nao se apaga.
#
# 1) garante uma aba do app aberta (a sessao OIDC do app so se renova com aba viva)
# 2) copia o token do navegador para o VPS
# 3) envia os PDFs que o VPS ja regerou para produtos que estavam sem arquivo

$raiz = Split-Path -Parent $PSScriptRoot
$log = Join-Path $raiz 'logs\manter_hotmart.log'
function Registrar($msg) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\GENIA-Hotmart-Vigia')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  Set-Location $raiz
  try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:9223/json/version }
  catch { Registrar 'Chrome 9223 fora do ar - abra o Chrome de automacao e logue na Hotmart'; exit 0 }

  $saida = & node scripts\garantir_aba_hotmart.js 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Registrar ('aba do app: ' + $saida.Trim()) }

  $saida = & node scripts\renovar_token_local.js 2>&1 | Out-String
  Registrar ('token: ' + $saida.Trim())

  $saida = & node scripts\enviarPdfsRegerados.js --limite=3 2>&1 | Out-String
  $ultima = ($saida.Trim() -split "`n")[-1]
  Registrar ('pdfs: ' + $ultima)

  # 4) livros novos: o servidor nao publica na Hotmart (sessao presa a esta
  #    maquina), entao os livros gerados la ficavam so na Cakto.
  $saida = & node scripts\publicar_local.js --limite=6 --minutos=17 2>&1 | Out-String
  $ultima = ($saida.Trim() -split "`n")[-1]
  Registrar ('publicar: ' + $ultima)

  # 5) capa e idioma dos recem-publicados (o assistente de cadastro nem sempre sobe a capa)
  $saida = & node scripts\capas_em_lote.js --lote=10 2>&1 | Out-String
  $ultima = ($saida.Trim() -split "`n")[-1]
  Registrar ('capas: ' + $ultima)
}
finally { $mutex.ReleaseMutex() }
