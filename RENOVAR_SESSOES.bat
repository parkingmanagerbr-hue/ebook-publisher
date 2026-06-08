@echo off
cd /d "%~dp0"
echo ============================================================
echo  RENOVAR SESSOES - Hotmart + Cakto
echo  Vai abrir o Chrome. Faca login em cada plataforma.
echo  O script detecta o login, salva a sessao e mapeia o
echo  marketplace de afiliados automaticamente.
echo ============================================================
echo.
node renew_and_discover.js all
echo.
echo ============================================================
echo  Pronto. Pode fechar esta janela.
echo ============================================================
pause
