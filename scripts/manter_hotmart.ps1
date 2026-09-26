$ErrorActionPreference = 'Continue'
# manter_hotmart.ps1 - manutencao local permanente das lojas que dependem do
# Chrome do dono (tarefa GENIA-Hotmart, a cada 30 min).
#
# O vigia das capas (manter_capas.ps1) renovava o token da Hotmart e se apagava
# quando o passe terminava. Em 16/09/2026 o passe acabou de madrugada e o token do
# servidor ficou a poucas horas de vencer - afiliacao, vendas e conferencia de
# conteudo dependem dele. Esta tarefa nao se apaga.
#
# 23/09/2026: a porta 9223 estava escrita aqui. O Chrome foi reaberto na 9222 e
# esta tarefa passou a registrar "Chrome fora do ar" e sair, sem publicar nada.
# Agora quem procura a porta (e abre o Chrome, se preciso) e o vigia.
#
# 1) vigia: acha/abre o Chrome de automacao e diz quais lojas pedem login
# 2) garante uma aba do app aberta (a sessao OIDC do app so se renova com aba viva)
# 3) copia o token do navegador para o VPS
# 4) envia os PDFs que o VPS ja regerou para produtos que estavam sem arquivo
# 5) publica livros novos na Hotmart e na Kiwify
# 6) capa e idioma dos recem-publicados

$raiz = Split-Path -Parent $PSScriptRoot
$log = Join-Path $raiz 'logs\manter_hotmart.log'
function Registrar($msg) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\GENIA-Hotmart-Vigia')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  Set-Location $raiz

  $vigia = & node scripts\vigia_navegador.js 2>&1 | Out-String
  $ultima = ($vigia.Trim() -split "`n")[-1]
  Registrar ('navegador: ' + $ultima)
  if ($ultima -notmatch '"porta":\d+') { Registrar 'sem Chrome de automacao - nada a fazer nesta rodada'; exit 0 }
  $semKiwify = $ultima -match '"kiwify":"deslogado"'

  # O vigia erra: em 26/09/2026 ele disse "hotmart: deslogado" enquanto o painel
  # estava LOGADO - o que morrera era a aba do app - e oito lotes seguidos
  # publicaram zero. Quem decide agora e o agente de sessao, que ABRE a tela e
  # olha; ele so pede gente quando ha senha ou codigo na frente (codigo 2).
  $saida = & node scripts\sessaoHotmart.js 2>&1 | Out-String
  $semHotmart = ($LASTEXITCODE -eq 2)
  Registrar ('sessao: ' + (($saida.Trim() -split "`n")[-1]))
  if ($semHotmart -and $semKiwify) { Registrar 'Hotmart e Kiwify deslogadas - so o dono pode logar (senha/2FA)'; exit 0 }

  if (-not $semHotmart) {

    $saida = & node scripts\enviarPdfsRegerados.js --limite=3 2>&1 | Out-String
    Registrar ('pdfs: ' + (($saida.Trim() -split "`n")[-1]))

    # livros novos: o servidor nao publica na Hotmart (sessao presa a esta maquina)
    $saida = & node scripts\publicar_local.js --limite=6 --minutos=14 2>&1 | Out-String
    Registrar ('publicar hotmart: ' + (($saida.Trim() -split "`n")[-1]))

    # capa e idioma dos recem-publicados (o assistente nem sempre sobe a capa)
    $saida = & node scripts\capas_em_lote.js --limite=10 2>&1 | Out-String
    Registrar ('capas: ' + (($saida.Trim() -split "`n")[-1]))
  } else { Registrar 'Hotmart deslogada - pulando a parte dela' }

  if (-not $semKiwify) {
    # A Kiwify estrangula o ritmo: lote pequeno, varias vezes por dia.
    $saida = & node scripts\publicar_kiwify.js --limite=10 2>&1 | Out-String
    Registrar ('publicar kiwify: ' + (($saida.Trim() -split "`n")[-1]))
  } else { Registrar 'Kiwify deslogada - pulando a parte dela' }
}
finally { $mutex.ReleaseMutex() }
