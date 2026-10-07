@echo off
rem Starts the Upscaler and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
title Upscaler
if not exist .venv\Scripts\python.exe (
    call setup.bat || exit /b 1
)
.venv\Scripts\python.exe server.py %*
if errorlevel 1 pause
