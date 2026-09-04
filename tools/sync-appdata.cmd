@echo off
rem Dev helper (Windows, Claude desktop app): the packaged Claude app redirects
rem AppData writes of everything it runs (dev server, shells) into its own
rem LocalCache. This merges that redirected copy into the real Roaming folder
rem so the real TexSwap.exe sees the same tool, cache and presets.
rem Run it OUTSIDE the package context, e.g. via Task Scheduler or a plain terminal.
set SRC=%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\AQ2TextureSwapper
set DST=%APPDATA%\AQ2TextureSwapper
robocopy "%SRC%" "%DST%" /E /XO /R:1 /W:1 /NFL /NDL /NJH > "%~dp0..\dist\sync-appdata.log" 2>&1
echo exit %ERRORLEVEL% >> "%~dp0..\dist\sync-appdata.log"
