@echo off
rem One-time setup: creates .venv and installs PyTorch (CUDA 12.6) + dependencies (~2.5 GB).
cd /d "%~dp0"
echo.
echo  Setting up Upscaler. This downloads about 2.5 GB and only happens once.
echo.
if not exist .venv\Scripts\python.exe (
    py -3.13 -m venv .venv || python -m venv .venv || goto :fail
)
.venv\Scripts\python.exe -m pip install --upgrade pip || goto :fail
.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126 || goto :fail
.venv\Scripts\python.exe -m pip install -r requirements.txt || goto :fail
echo.
echo  Setup complete.
exit /b 0

:fail
echo.
echo  Setup failed. See the messages above.
pause
exit /b 1
