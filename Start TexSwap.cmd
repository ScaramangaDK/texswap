@echo off
title TexSwap - close this window to quit the app
echo Starting TexSwap...
echo The app opens in your browser at http://127.0.0.1:5892
echo (keep this window open while using the app)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5892"
node "%~dp0devserver.js"
pause
