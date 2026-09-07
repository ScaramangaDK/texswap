@echo off
REM ============================================================
REM  TexSwap helper - installs the AI upscaler (Real-ESRGAN)
REM  without needing a TexSwap update. Safe to run more than once.
REM
REM  It downloads the official open-source release (~45 MB) from
REM  the Real-ESRGAN GitHub page and unpacks it where TexSwap
REM  looks for it. Nothing else on your PC is touched.
REM ============================================================
setlocal
set "DEST=%APPDATA%\AQ2TextureSwapper\tools\realesrgan"
echo.
echo Installing the AI upscaler (Real-ESRGAN, ~45 MB) to:
echo   %DEST%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $d=Join-Path $env:APPDATA 'AQ2TextureSwapper\tools\realesrgan'; New-Item -ItemType Directory -Force $d | Out-Null; $z=Join-Path $d 'download.zip'; Write-Host 'Downloading...'; Invoke-WebRequest 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip' -OutFile $z; Write-Host 'Unpacking...'; Expand-Archive -Path $z -DestinationPath $d -Force; Remove-Item $z -Force"
echo.
if exist "%DEST%\realesrgan-ncnn-vulkan.exe" (
  echo Done! Open TexSwap's "AI upscale" view again - it is ready to use now.
  echo No restart needed.
) else (
  echo Something went wrong - the upscaler did not land where expected.
  echo You can also install it by hand: download
  echo   https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip
  echo and extract it into %DEST%
  echo so realesrgan-ncnn-vulkan.exe sits directly in that folder.
)
echo.
pause
