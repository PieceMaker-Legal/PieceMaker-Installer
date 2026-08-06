# Script PowerShell pour créer un certificat self-signed sur Windows
# Exécuter en tant qu'administrateur

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "Création d'un certificat self-signed" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$certName = "PieceMaker Developer Certificate"
$certPassword = "piecemaker"

# Vérifier si le certificat existe déjà
$existingCert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*$certName*" }

if ($existingCert) {
    Write-Host "⚠️  Un certificat '$certName' existe déjà." -ForegroundColor Yellow
    Write-Host ""
    $response = Read-Host "Voulez-vous le supprimer et en créer un nouveau? (o/N)"

    if ($response -eq "o" -or $response -eq "O") {
        Remove-Item -Path "Cert:\CurrentUser\My\$($existingCert.Thumbprint)" -Force
        Write-Host "✅ Ancien certificat supprimé" -ForegroundColor Green
    } else {
        Write-Host "❌ Opération annulée. Utilisez le certificat existant." -ForegroundColor Red
        exit 0
    }
}

Write-Host ""
Write-Host "📝 Création du certificat..." -ForegroundColor Yellow
Write-Host ""

# Créer le certificat
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$certName, O=PieceMaker, C=FR" `
    -KeyUsage DigitalSignature `
    -FriendlyName $certName `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
    -NotAfter (Get-Date).AddYears(2)

Write-Host "✅ Certificat créé avec succès" -ForegroundColor Green
Write-Host "   Thumbprint: $($cert.Thumbprint)" -ForegroundColor Gray
Write-Host ""

# Exporter le certificat vers un fichier PFX
Write-Host "📦 Export du certificat..." -ForegroundColor Yellow

$pfxPath = Join-Path $PSScriptRoot "piecemaker-cert.pfx"
$securePassword = ConvertTo-SecureString -String $certPassword -Force -AsPlainText

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword | Out-Null

Write-Host "✅ Certificat exporté vers: $pfxPath" -ForegroundColor Green
Write-Host ""

# Ajouter le certificat au magasin de certificats racine de confiance
Write-Host "🔐 Ajout du certificat aux certificats de confiance..." -ForegroundColor Yellow
Write-Host "   (Nécessite les droits administrateur)" -ForegroundColor Gray
Write-Host ""

try {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    $store.Open("ReadWrite")
    $store.Add($cert)
    $store.Close()

    Write-Host "✅ Certificat ajouté aux certificats de confiance" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Erreur lors de l'ajout aux certificats de confiance: $_" -ForegroundColor Red
    Write-Host "   Vous devrez peut-être exécuter ce script en tant qu'administrateur" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "📋 Informations du certificat:" -ForegroundColor Cyan
Write-Host "   Nom: $($cert.Subject)" -ForegroundColor Gray
Write-Host "   Thumbprint: $($cert.Thumbprint)" -ForegroundColor Gray
Write-Host "   Valide du: $($cert.NotBefore)" -ForegroundColor Gray
Write-Host "   Expire le: $($cert.NotAfter)" -ForegroundColor Gray
Write-Host ""

# Créer un fichier de configuration pour electron-builder
$configContent = @"
certificateFile: piecemaker-cert.pfx
certificatePassword: $certPassword
"@

$configPath = Join-Path $PSScriptRoot "certificate-config.yml"
Set-Content -Path $configPath -Value $configContent

Write-Host "📝 Configuration enregistrée dans: certificate-config.yml" -ForegroundColor Green
Write-Host ""

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "✅ Configuration terminée!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Le certificat '$certName' est maintenant installé et approuvé." -ForegroundColor White
Write-Host "Vous pouvez maintenant exécuter 'npm run build:win' pour créer l'installateur signé." -ForegroundColor White
Write-Host ""
Write-Host "⚠️  IMPORTANT: Conservez le fichier 'piecemaker-cert.pfx' en lieu sûr!" -ForegroundColor Yellow
Write-Host "   Mot de passe du certificat: $certPassword" -ForegroundColor Yellow
Write-Host ""
