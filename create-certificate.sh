#!/bin/bash

# Script de création d'un certificat self-signed pour signer l'application macOS
# Ce certificat doit être créé et approuvé localement sur la machine de l'utilisateur

echo "======================================"
echo "Création d'un certificat self-signed"
echo "======================================"
echo ""

# Nom du certificat
CERT_NAME="PieceMaker Developer Certificate"

# Vérifier si le certificat existe déjà
if security find-certificate -c "$CERT_NAME" -p /dev/null 2>/dev/null; then
    echo "⚠️  Un certificat '$CERT_NAME' existe déjà dans le trousseau."
    echo ""
    read -p "Voulez-vous le supprimer et en créer un nouveau? (o/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Oo]$ ]]; then
        # Trouver et supprimer le certificat existant
        CERT_HASH=$(security find-certificate -c "$CERT_NAME" -Z | grep "SHA-1" | awk '{print $3}')
        if [ ! -z "$CERT_HASH" ]; then
            security delete-certificate -Z "$CERT_HASH"
            echo "✅ Ancien certificat supprimé"
        fi
    else
        echo "❌ Opération annulée. Utilisez le certificat existant."
        exit 0
    fi
fi

echo ""
echo "📝 Création du certificat..."
echo ""

# Créer un certificat temporaire avec openssl
openssl req -x509 -newkey rsa:4096 -keyout /tmp/piecemaker-key.pem -out /tmp/piecemaker-cert.pem -days 365 -nodes \
    -subj "/CN=$CERT_NAME/O=PieceMaker/C=FR"

# Convertir en format PKCS12
openssl pkcs12 -export -out /tmp/piecemaker-cert.p12 \
    -inkey /tmp/piecemaker-key.pem \
    -in /tmp/piecemaker-cert.pem \
    -passout pass:piecemaker

echo ""
echo "📥 Importation du certificat dans le trousseau..."
echo ""

# Importer dans le trousseau login
security import /tmp/piecemaker-cert.p12 -k ~/Library/Keychains/login.keychain-db -P piecemaker -T /usr/bin/codesign

# Trouver le hash du certificat nouvellement créé
CERT_HASH=$(security find-certificate -c "$CERT_NAME" -Z | grep "SHA-1" | awk '{print $3}')

if [ -z "$CERT_HASH" ]; then
    echo "❌ Erreur: Impossible de trouver le certificat après importation"
    exit 1
fi

echo "✅ Certificat importé avec succès"
echo "   Hash: $CERT_HASH"
echo ""

# Approuver le certificat pour la signature de code
echo "🔐 Configuration de la confiance du certificat..."
echo "   Vous devrez entrer votre mot de passe administrateur..."
echo ""

# Définir la confiance pour la signature de code
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/piecemaker-cert.pem

# Permettre à codesign d'utiliser le certificat sans demander le mot de passe
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" ~/Library/Keychains/login.keychain-db

echo ""
echo "✅ Certificat configuré avec succès!"
echo ""
echo "📋 Informations du certificat:"
security find-certificate -c "$CERT_NAME" -p | openssl x509 -noout -subject -issuer -dates

# Nettoyer les fichiers temporaires
rm /tmp/piecemaker-key.pem /tmp/piecemaker-cert.pem /tmp/piecemaker-cert.p12

echo ""
echo "======================================"
echo "✅ Configuration terminée!"
echo "======================================"
echo ""
echo "Le certificat '$CERT_NAME' est maintenant installé et approuvé."
echo "Vous pouvez maintenant exécuter 'npm run build:mac' pour créer le .dmg signé."
echo ""
