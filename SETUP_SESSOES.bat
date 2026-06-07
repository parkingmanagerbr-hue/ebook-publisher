@echo off
title GENIA - Setup Sessoes Web Ebook
echo.
echo ===============================================================
echo  GENIA - Setup de Sessoes para Gamma, Piktochart, ebookmaker
echo ===============================================================
echo.
echo  Este script vai abrir o Chrome para voce fazer login com Google
echo  em cada servico. Faca login normalmente e aguarde.
echo.
echo  Quando terminar, as sessoes serao enviadas para o VPS.
echo.
pause
cd /d C:\Users\m_rov\ClaudeProjects\EbookPublisher
node scripts/setup-web-sessions.js
pause
