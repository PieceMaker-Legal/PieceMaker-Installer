#!/usr/bin/env node

/**
 * Script de vérification de l'installation PieceMaker
 * Vérifie que tous les fichiers et dépendances sont présents
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function checkFile(filepath, required = true) {
  if (fs.existsSync(filepath)) {
    log(`  ✓ ${filepath}`, 'green');
    return true;
  } else {
    const level = required ? 'red' : 'yellow';
    const symbol = required ? '✗' : '⚠';
    log(`  ${symbol} ${filepath} ${required ? 'MANQUANT' : 'optionnel'}`, level);
    return false;
  }
}

function checkCommand(command, name) {
  try {
    execSync(`${command} --version`, { stdio: 'ignore' });
    log(`  ✓ ${name} installé`, 'green');
    return true;
  } catch (error) {
    log(`  ✗ ${name} NON installé`, 'red');
    return false;
  }
}

function checkPackageJson() {
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    log(`  ✓ package.json valide (v${pkg.version})`, 'green');
    return true;
  } catch (error) {
    log(`  ✗ package.json invalide: ${error.message}`, 'red');
    return false;
  }
}

async function main() {
  log('\n╔════════════════════════════════════════════╗', 'blue');
  log('║  PieceMaker - Vérification Installation  ║', 'blue');
  log('╚════════════════════════════════════════════╝\n', 'blue');

  let allGood = true;

  // 1. Vérifier Node.js et npm
  log('1️⃣  Vérification des prérequis système\n', 'bright');
  allGood &= checkCommand('node', 'Node.js');
  allGood &= checkCommand('npm', 'npm');
  
  try {
    const nodeVersion = execSync('node --version').toString().trim();
    const versionNum = parseInt(nodeVersion.split('.')[0].replace('v', ''));
    if (versionNum >= 16) {
      log(`  ✓ Version Node.js OK: ${nodeVersion}`, 'green');
    } else {
      log(`  ⚠ Version Node.js: ${nodeVersion} (recommandé: 16+)`, 'yellow');
    }
  } catch (e) {}

  // 2. Vérifier les fichiers principaux
  log('\n2️⃣  Vérification des fichiers principaux\n', 'bright');
  allGood &= checkFile('package.json');
  allGood &= checkFile('main.js');
  allGood &= checkFile('index.html');
  allGood &= checkFile('renderer.js');
  allGood &= checkFile('background.png');

  // 3. Vérifier les fichiers du add-in
  log('\n3️⃣  Vérification du complément Word\n', 'bright');
  allGood &= checkFile('taskpane/manifest.xml');
  allGood &= checkFile('websocket-server/server.cjs');
  allGood &= checkFile('mcp-server/mcp-server-local.js');
  allGood &= checkFile('taskpane/taskpane.html');
  allGood &= checkFile('taskpane/taskpane.js');
  allGood &= checkFile('taskpane/taskpane.css');

  // 4. Vérifier les icônes
  log('\n4️⃣  Vérification des icônes\n', 'bright');
  allGood &= checkFile('taskpane/assets/icon-16.png');
  allGood &= checkFile('addon/assets/icon-32.png');
  allGood &= checkFile('addon/assets/icon-64.png');
  allGood &= checkFile('addon/assets/icon-80.png');
  allGood &= checkFile('electron/build/icon.png');
  checkFile('build/icon.ico', false);
  checkFile('build/icon.icns', false);

  // 5. Vérifier les scripts de build
  log('\n5️⃣  Vérification des scripts de build\n', 'bright');
  checkFile('build.sh', false);
  checkFile('build.bat', false);
  checkFile('generate_icons.py', false);

  // 6. Vérifier la documentation
  log('\n6️⃣  Vérification de la documentation\n', 'bright');
  checkFile('README.md', false);
  checkFile('QUICKSTART.md', false);
  checkFile('INSTALL.md', false);
  checkFile('PRESENTATION.md', false);

  // 7. Vérifier les dépendances npm
  log('\n7️⃣  Vérification des dépendances npm\n', 'bright');
  
  if (fs.existsSync('node_modules')) {
    log('  ✓ node_modules/ présent', 'green');
    
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    
    log(`  ℹ️  ${deps.length} dépendances, ${devDeps.length} dev-dépendances`, 'blue');
  } else {
    log('  ⚠ node_modules/ absent - Exécutez: npm install', 'yellow');
  }

  if (fs.existsSync('taskpane/node_modules')) {
    log('  ✓ addon/node_modules/ présent', 'green');
  } else {
    log('  ⚠ addon/node_modules/ absent - Exécutez: cd addon && npm install', 'yellow');
  }

  // 8. Vérification de la configuration
  log('\n8️⃣  Vérification de la configuration\n', 'bright');
  
  if (checkPackageJson()) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    if (pkg.build) {
      log('  ✓ Configuration electron-builder présente', 'green');
      
      if (pkg.build.appId) {
        log(`  ✓ App ID: ${pkg.build.appId}`, 'green');
      }
      
      if (pkg.build.win) {
        log('  ✓ Configuration Windows présente', 'green');
      }
      
      if (pkg.build.mac) {
        log('  ✓ Configuration macOS présente', 'green');
      }
    }
  }

  // 9. Résumé
  log('\n╔════════════════════════════════════════════╗', 'blue');
  log('║              RÉSUMÉ                       ║', 'blue');
  log('╚════════════════════════════════════════════╝\n', 'blue');

  if (allGood) {
    log('✅ Tout est prêt ! Vous pouvez builder l\'application.\n', 'green');
    log('Commandes disponibles:', 'bright');
    log('  • npm start          - Mode développement', 'blue');
    log('  • npm run build:win  - Build Windows', 'blue');
    log('  • npm run build:mac  - Build macOS', 'blue');
    log('  • npm run build:all  - Build toutes plateformes\n', 'blue');
  } else {
    log('⚠️  Certains fichiers sont manquants.\n', 'yellow');
    log('Actions recommandées:', 'bright');
    log('  1. Vérifier l\'extraction complète de l\'archive', 'yellow');
    log('  2. Exécuter: npm install', 'yellow');
    log('  3. Exécuter: cd addon && npm install', 'yellow');
    log('  4. Générer les icônes manquantes (voir INSTALL.md)\n', 'yellow');
  }

  log('📚 Documentation:', 'bright');
  log('  • README.md       - Guide utilisateur complet', 'blue');
  log('  • QUICKSTART.md   - Démarrage rapide', 'blue');
  log('  • INSTALL.md      - Guide d\'installation détaillé', 'blue');
  log('  • PRESENTATION.md - Présentation du projet\n', 'blue');
}

main().catch(console.error);
