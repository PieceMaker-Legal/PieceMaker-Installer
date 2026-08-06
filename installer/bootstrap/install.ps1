<#
  PieceMaker — amorçage Windows.

    irm https://raw.githubusercontent.com/PieceMaker-Legal/PieceMaker-Installer/main/installer/bootstrap/install.ps1 | iex

  Clone (ou met à jour) le dépôt puis lance l'installateur interactif.
  Variables : PIECEMAKER_DIR (défaut ~\PieceMaker), PIECEMAKER_REF (défaut main).
#>

$ErrorActionPreference = 'Stop'

$RepoUrl   = if ($env:PIECEMAKER_REPO) { $env:PIECEMAKER_REPO } else { 'https://github.com/PieceMaker-Legal/PieceMaker-Installer.git' }
$TargetDir = if ($env:PIECEMAKER_DIR)  { $env:PIECEMAKER_DIR }  else { Join-Path $HOME 'PieceMaker' }
$Ref       = if ($env:PIECEMAKER_REF)  { $env:PIECEMAKER_REF }  else { 'main' }

function Write-Info { param($m) Write-Host "  > $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  v $m" -ForegroundColor Green }
function Write-Fail { param($m) Write-Host "  x $m" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  PieceMaker - amorcage' -ForegroundColor Cyan
Write-Host ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Fail 'git est requis : https://git-scm.com/download/win'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail 'Node.js 18+ est requis : https://nodejs.org/'
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) {
  Write-Fail "Node.js 18+ requis (detecte : $(node --version))."
}
Write-Ok "Node.js $(node --version)"

if (Test-Path (Join-Path $TargetDir '.git')) {
  Write-Info "Depot existant : $TargetDir"
  git -C $TargetDir fetch --depth 1 origin $Ref
  git -C $TargetDir diff --quiet
  $dirty = $LASTEXITCODE -ne 0
  git -C $TargetDir diff --cached --quiet
  if ($dirty -or $LASTEXITCODE -ne 0) {
    Write-Fail "Modifications locales non validees dans $TargetDir. Committez ou remisez-les d'abord."
  }
  git -C $TargetDir checkout --detach FETCH_HEAD
  Write-Ok "Depot mis a jour ($Ref)"
}
elseif (Test-Path $TargetDir) {
  Write-Fail "$TargetDir existe mais n'est pas un depot git. Choisissez un autre PIECEMAKER_DIR."
}
else {
  Write-Info "Clone dans $TargetDir"
  git clone --depth 1 --branch $Ref $RepoUrl $TargetDir
  Write-Ok 'Depot clone'
}

Set-Location $TargetDir

# --ignore-scripts : le postinstall lance electron-builder, inutile ici.
Write-Info 'Installation des dependances Node'
npm install --no-audit --no-fund --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Fail 'npm install a echoue.' }
Write-Ok 'Dependances installees'

Write-Host ''
node installer/bin/piecemaker.mjs @args
exit $LASTEXITCODE
