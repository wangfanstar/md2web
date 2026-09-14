@echo off
cd /d "%~dp0"
python serve.py %*
if %errorlevel% equ 9009 py serve.py %*
