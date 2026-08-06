@echo off
chcp 65001 > nul
cls

echo ======================================
echo 🚀 PieceMaker Word Assistant - Build
echo ======================================
echo.

:: Vérifier Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js n'est pas installé
    echo Téléchargez-le depuis: https://nodejs.org/
    pause
    exit /b 1
)

node --version
npm --version
echo.

:: Installer les dépendances si nécessaire
if not exist "node_modules" (
    echo 📦 Installation des dépendances...
    call npm install
    echo.
)

:: Installer les dépendances du add-in
if not exist "addon\node_modules" (
    echo 📦 Installation des dépendances du add-in...
    cd addon
    call npm install
    cd ..
    echo.
)

:: Menu
echo Que voulez-vous faire?
echo 1) Build pour Windows (64-bit)
echo 2) Build pour Windows (32-bit)
echo 3) Build portable
echo 4) Démarrer en mode développement
echo.
set /p choice="Votre choix (1-4): "

if "%choice%"=="1" (
    echo.
    echo 🏗️  Build pour Windows 64-bit...
    call npm run build:win
) else if "%choice%"=="2" (
    echo.
    echo 🏗️  Build pour Windows 32-bit...
    call npm run build -- --win --ia32
) else if "%choice%"=="3" (
    echo.
    echo 🏗️  Build portable...
    call npm run build -- --win portable
) else if "%choice%"=="4" (
    echo.
    echo 🔧 Démarrage en mode développement...
    call npm start
) else (
    echo ❌ Choix invalide
    pause
    exit /b 1
)

echo.
echo ✅ Terminé!
echo.
echo Les fichiers sont dans le dossier: dist\
echo.
pause
