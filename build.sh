#!/bin/bash

echo "L'interface Electron est désactivée pour le moment."
echo "Utilisez : piecemaker open"
exit 1

echo "🚀 PieceMaker Word Assistant - Script de build"
echo "=============================================="
echo ""

# Vérifier que Node.js est installé
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé"
    echo "Téléchargez-le depuis: https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js version: $(node --version)"
echo "✓ npm version: $(npm --version)"
echo ""

# Installer les dépendances si nécessaire
if [ ! -d "node_modules" ]; then
    echo "📦 Installation des dépendances..."
    npm install
    echo ""
fi

# Installer les dépendances du add-in
if [ ! -d "addon/node_modules" ]; then
    echo "📦 Installation des dépendances du add-in..."
    cd addon
    npm install
    cd ..
    echo ""
fi

# Menu de build
echo "Que voulez-vous faire?"
echo "1) Build pour Windows (64-bit)"
echo "2) Build pour macOS (Intel & Apple Silicon)"
echo "3) Build pour Linux"
echo "4) Build pour toutes les plateformes"
echo "5) Démarrer en mode développement"
echo ""
read -p "Votre choix (1-5): " choice

case $choice in
    1)
        echo ""
        echo "🏗️  Build pour Windows..."
        npm run build:win
        ;;
    2)
        echo ""
        echo "🏗️  Build pour macOS..."
        npm run build:mac
        ;;
    3)
        echo ""
        echo "🏗️  Build pour Linux..."
        npm run build -- --linux
        ;;
    4)
        echo ""
        echo "🏗️  Build pour toutes les plateformes..."
        npm run build:all
        ;;
    5)
        echo ""
        echo "🔧 Démarrage en mode développement..."
        npm start
        ;;
    *)
        echo "❌ Choix invalide"
        exit 1
        ;;
esac

echo ""
echo "✅ Terminé!"
echo ""
echo "Les fichiers sont dans le dossier: dist/"
