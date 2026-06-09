@echo off
cd /d "%~dp0"
echo.
echo  ====================================
echo    Solemate local server starting...
echo  ====================================
echo.
echo  Browser will open at http://localhost:8765/
echo  Keep this window open while using the app.
echo  Close this window to stop the server.
echo.

where python >nul 2>nul
if not errorlevel 1 (
    start "" http://localhost:8765/
    python -m http.server 8765
    goto end
)

where py >nul 2>nul
if not errorlevel 1 (
    start "" http://localhost:8765/
    py -m http.server 8765
    goto end
)

where node >nul 2>nul
if not errorlevel 1 (
    start "" http://localhost:8765/
    npx --yes serve -p 8765 .
    goto end
)

echo.
echo  Python or Node.js is required.
echo  Install Python from https://www.python.org
echo  Make sure to check "Add Python to PATH" during install.
echo.
pause

:end
