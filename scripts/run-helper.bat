@echo off
:: Convert this script's own Windows path to a WSL path — no hardcoded usernames.
:: The inner wsl.exe MUST read stdin from NUL (^<nul); otherwise it drains the
:: native-messaging stdin pipe Chrome opened, leaving the real `node` host with
:: no message to read — the host then never replies and Chrome hangs forever.
for /f "tokens=*" %%i in ('wsl.exe wslpath -u "%~dp0..\helper\dist\index.js" ^<nul') do set "WSLPATH=%%i"
wsl.exe node "%WSLPATH%"
