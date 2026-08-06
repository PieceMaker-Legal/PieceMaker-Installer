#!/usr/bin/env node
/**
 * PieceMaker Codebase Migration Script
 * 
 * This script reorganizes the codebase into 6 folders:
 * - mcp-server/       : MCP protocol implementation
 * - taskpane/         : Word Add-in frontend
 * - electron/         : Desktop application
 * - websocket-server/ : Backend API + Python scripts
 * - certificates/     : SSL certificates (shared)
 * - output/           : File storage (shared)
 * 
 * Usage: node migrate.js
 * Dry run: node migrate.js --dry-run
 * Rollback: node migrate.js --rollback
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');
const BACKUP_DIR = '.migration-backup-' + Date.now();

// ============================================================================
// FILE MIGRATION CONFIGURATION
// ============================================================================

// Individual files to move
const FILES_TO_MOVE = [
  // MCP Server
  ['addon/mcp-server-local.js', 'mcp-server/mcp-server-local.js'],
  
  // Taskpane
  ['addon/taskpane.js', 'taskpane/taskpane.js'],
  ['addon/taskpane.html', 'taskpane/taskpane.html'],
  ['addon/taskpane.css', 'taskpane/taskpane.css'],
  ['addon/manifest.xml', 'taskpane/manifest.xml'],
  ['addon/commands.html', 'taskpane/commands.html'],
  ['addon/extraction.js', 'taskpane/extraction.js'],
  
  // WebSocket Server
  ['addon/server.cjs', 'websocket-server/server.cjs'],
  ['addon/verify-certificates.cjs', 'websocket-server/verify-certificates.cjs'],
  ['addon/generate-ca-certificates.cjs', 'websocket-server/generate-ca-certificates.cjs'],
  ['addon/localhost.key', 'websocket-server/localhost.key'],
  ['addon/localhost.crt', 'websocket-server/localhost.crt'],
  
  // Certificates
  ['addon/piecemaker-ca.crt', 'certificates/piecemaker-ca.crt'],
  ['addon/piecemaker-ca.key', 'certificates/piecemaker-ca.key'],
  ['piecemaker.crt', 'certificates/piecemaker.crt'],
  ['piecemaker.key', 'certificates/piecemaker.key'],
  ['piecemaker-cert.pfx', 'certificates/piecemaker-cert.pfx'],
  
  // Electron
  ['main.js', 'electron/main.js'],
  ['index.html', 'electron/index.html'],
  ['renderer.js', 'electron/renderer.js'],
  ['config.js', 'electron/config.js'],
  ['UpdateManager.js', 'electron/UpdateManager.js'],
  ['verify.js', 'electron/verify.js'],
  ['verify-files.js', 'electron/verify-files.js'],
  ['remove-bom.js', 'electron/remove-bom.js'],
  ['update-styles.css', 'electron/update-styles.css'],
  ['background.png', 'electron/background.png'],
];

// Directories to copy (recursive)
const DIRS_TO_COPY = [
  ['addon/modules', 'taskpane/modules'],
  ['addon/assets', 'taskpane/assets'],
  ['addon/src', 'taskpane/src'],
  ['addon/dist', 'taskpane/dist'],
  ['addon/scripts', 'websocket-server/scripts'],
  ['build', 'electron/build'],
  ['addon/output', 'output'],
];

// Directories to create
const DIRS_TO_CREATE = [
  'mcp-server',
  'taskpane/modules',
  'taskpane/assets',
  'taskpane/src',
  'taskpane/dist',
  'websocket-server/scripts',
  'certificates',
  'electron/build',
  'output'
];

// Files to delete after migration
const FILES_TO_DELETE = [
  'addon/package.json',
  'manifest.xml',  // root-level duplicate of taskpane/manifest.xml
];

// ============================================================================
// PATH REPLACEMENTS IN SOURCE FILES
// ============================================================================

const FILE_UPDATES = [
  {
    file: 'electron/main.js',
    updates: [
      { from: /path\.join\(__dirname,\s*['"]addon['"]\)/g, to: "path.join(__dirname, '..', 'taskpane')" },
      { from: /path\.join\(process\.resourcesPath,\s*['"]app\.asar\.unpacked['"],\s*['"]addon['"]\)/g, to: "path.join(process.resourcesPath, 'app.asar.unpacked', 'taskpane')" },
      { from: "path.join(addonPath, 'server.cjs')", to: "path.join(__dirname, '..', 'websocket-server', 'server.cjs')" },
      { from: "path.join(addonPath, 'mcp-server-local.js')", to: "path.join(__dirname, '..', 'mcp-server', 'mcp-server-local.js')" },
      { from: "mainWindow.loadFile('index.html')", to: "mainWindow.loadFile(path.join(__dirname, 'index.html'))" },
      { from: /path\.join\(addonPath,\s*['"]output['"]\)/g, to: "path.join(__dirname, '..', 'output')" },
      { from: "path.join(addonPath, 'piecemaker-ca.crt')", to: "path.join(__dirname, '..', 'certificates', 'piecemaker-ca.crt')" },
    ]
  },
  {
    file: 'electron/UpdateManager.js',
    updates: [
      { from: /path\.join\(__dirname,\s*['"]addon['"]\)/g, to: "path.join(__dirname, '..', 'taskpane')" },
      { from: /path\.join\(process\.resourcesPath,\s*['"]app\.asar\.unpacked['"],\s*['"]addon['"]\)/g, to: "path.join(process.resourcesPath, 'app.asar.unpacked', 'taskpane')" },
    ]
  },
  {
    file: 'websocket-server/server.cjs',
    updates: [
      { from: "path.join(__dirname, 'output')", to: "path.join(__dirname, '..', 'output')" },
      { from: "path.join(__dirname, 'piecemaker-ca.crt')", to: "path.join(__dirname, '..', 'certificates', 'piecemaker-ca.crt')" },
      { from: /addon\/generate-ca-certificates/g, to: 'websocket-server/generate-ca-certificates' },
      { from: "require('./modules/anonymization-server.cjs')", to: "require('../taskpane/modules/anonymization-server.cjs')" },
      { from: "app.use(express.static(__dirname));", to: "app.use(express.static(path.join(__dirname, '..', 'taskpane')));" },
    ]
  },
  {
    file: 'electron/remove-bom.js',
    updates: [
      { from: "'addon/**/*.js'", to: "'taskpane/**/*.js'" },
      { from: /addon\//g, to: 'taskpane/' },
    ]
  },
  {
    file: 'electron/verify-files.js',
    updates: [
      { from: "'addon/**/*.js'", to: "'taskpane/**/*.js'" },
      { from: /addon\//g, to: 'taskpane/' },
    ]
  },
  {
    file: 'electron/verify.js',
    updates: [
      { from: "'addon/manifest.xml'", to: "'taskpane/manifest.xml'" },
      { from: "'addon/server.js'", to: "'websocket-server/server.cjs'" },
      { from: "'addon/mcp-server-local.js'", to: "'mcp-server/mcp-server-local.js'" },
      { from: "'addon/taskpane.html'", to: "'taskpane/taskpane.html'" },
      { from: "'addon/taskpane.js'", to: "'taskpane/taskpane.js'" },
      { from: "'addon/taskpane.css'", to: "'taskpane/taskpane.css'" },
      { from: "'addon/assets/icon-", to: "'taskpane/assets/icon-" },
      { from: "'addon/node_modules'", to: "'taskpane/node_modules'" },
      { from: "'build/icon.png'", to: "'electron/build/icon.png'" },
    ]
  },
  {
    file: 'package.json',
    updates: [
      { from: '"main": "main.js"', to: '"main": "electron/main.js"' },
      { from: '"buildResources": "build"', to: '"buildResources": "electron/build"' },
      { from: /"asarUnpack":\s*\[\s*"addon\/\*\*\/\*",\s*"node_modules\/\*\*\/\*"/g, to: '"asarUnpack": [\n      "mcp-server/**/*",\n      "taskpane/**/*",\n      "websocket-server/**/*",\n      "certificates/**/*",\n      "output/**/*",\n      "node_modules/**/*"' },
    ]
  },
  {
    file: '.claude/settings.local.json',
    updates: [
      { from: 'python addon/scripts/presidio_scan.py', to: 'python websocket-server/scripts/presidio_scan.py' },
    ]
  }
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message, type = 'info') {
  const prefix = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warning: '⚠️',
    dry: '📝'
  }[type] || 'ℹ️';
  
  console.log(`${prefix} ${message}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    if (DRY_RUN) {
      log(`Would create directory: ${dir}`, 'dry');
    } else {
      fs.mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`, 'success');
    }
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    log(`Source not found: ${src}`, 'warning');
    return;
  }
  
  ensureDir(dest);
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      if (DRY_RUN) {
        log(`Would copy file: ${srcPath} → ${destPath}`, 'dry');
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  
  if (!DRY_RUN) {
    log(`Copied directory: ${src} → ${dest}`, 'success');
  }
}

function moveFile(from, to) {
  if (!fs.existsSync(from)) {
    log(`Source not found: ${from}`, 'warning');
    return false;
  }
  
  if (DRY_RUN) {
    log(`Would move: ${from} → ${to}`, 'dry');
    return true;
  }
  
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
  log(`Moved: ${from} → ${to}`, 'success');
  return true;
}

function deleteFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  
  if (DRY_RUN) {
    log(`Would delete: ${filePath}`, 'dry');
  } else {
    fs.unlinkSync(filePath);
    log(`Deleted: ${filePath}`, 'success');
  }
}

function updateFile(filePath, updates) {
  if (!fs.existsSync(filePath)) {
    log(`File not found for update: ${filePath}`, 'warning');
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;
  
  for (const { from, to } of updates) {
    if (from.test ? from.test(content) : content.includes(from)) {
      content = content.replace(from, to);
      modified = true;
    }
  }
  
  if (modified) {
    if (DRY_RUN) {
      log(`Would update paths in: ${filePath}`, 'dry');
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
      log(`Updated paths in: ${filePath}`, 'success');
    }
  }
}

function createBackup() {
  if (DRY_RUN) {
    log(`Would create backup in: ${BACKUP_DIR}`, 'dry');
    return;
  }
  
  log(`Creating backup in: ${BACKUP_DIR}`, 'info');
  ensureDir(BACKUP_DIR);
  
  // Backup files
  for (const [from] of FILES_TO_MOVE) {
    if (fs.existsSync(from)) {
      const backupPath = path.join(BACKUP_DIR, from);
      ensureDir(path.dirname(backupPath));
      fs.copyFileSync(from, backupPath);
    }
  }
  
  // Backup directories
  for (const [from] of DIRS_TO_COPY) {
    if (fs.existsSync(from)) {
      copyDir(from, path.join(BACKUP_DIR, from));
    }
  }

  // Backup files that are only updated (not moved), so rollback can restore them
  const FILES_TO_BACKUP_ONLY = ['package.json', '.claude/settings.local.json'];
  for (const file of FILES_TO_BACKUP_ONLY) {
    if (fs.existsSync(file)) {
      const backupPath = path.join(BACKUP_DIR, file);
      ensureDir(path.dirname(backupPath));
      fs.copyFileSync(file, backupPath);
    }
  }

  log('Backup created', 'success');
}

// ============================================================================
// MAIN MIGRATION
// ============================================================================

function migrate() {
  log('Starting PieceMaker codebase migration...', 'info');
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`, 'info');
  console.log('');
  
  // Create backup
  if (!DRY_RUN) {
    createBackup();
    console.log('');
  }
  
  // Create directories
  log('Creating new directory structure...', 'info');
  for (const dir of DIRS_TO_CREATE) {
    ensureDir(dir);
  }
  console.log('');
  
  // Move files
  log('Moving files...', 'info');
  for (const [from, to] of FILES_TO_MOVE) {
    moveFile(from, to);
  }
  console.log('');
  
  // Copy directories
  log('Copying directories...', 'info');
  for (const [from, to] of DIRS_TO_COPY) {
    copyDir(from, to);
  }
  console.log('');
  
  // Delete unnecessary files
  log('Cleaning up unnecessary files...', 'info');
  for (const file of FILES_TO_DELETE) {
    deleteFile(file);
  }
  console.log('');
  
  // Update file contents
  log('Updating path references...', 'info');
  for (const { file, updates } of FILE_UPDATES) {
    updateFile(file, updates);
  }
  console.log('');

  // Create mcp-server/package.json to enable ESM (import syntax)
  if (!DRY_RUN) {
    const mcpPkg = 'mcp-server/package.json';
    fs.writeFileSync(mcpPkg, '{\n  "type": "module"\n}\n', 'utf8');
    log(`Created: ${mcpPkg}`, 'success');
  } else {
    log('Would create: mcp-server/package.json', 'dry');
  }
  console.log('');
  
  // Clean up old empty directories
  if (!DRY_RUN) {
    log('Cleaning up old directories...', 'info');
    const oldDirs = ['addon', 'build'];
    for (const dir of oldDirs) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          log(`Removed old directory: ${dir}`, 'success');
        } catch (e) {
          log(`Could not remove ${dir}: ${e.message}`, 'warning');
        }
      }
    }
    console.log('');
  }
  
  // Summary
  log('Migration complete!', 'success');
  if (!DRY_RUN) {
    log(`Backup available at: ${BACKUP_DIR}`, 'info');
    log('To rollback: node migrate.js --rollback', 'info');
  }
  
  console.log('\n📋 Next steps:');
  console.log('  1. Review the changes');
  console.log('  2. Test: npm start');
  console.log('  3. Test build: npm run build');
  console.log('  4. Commit changes: git add . && git commit -m "Reorganize codebase"');
}

// ============================================================================
// ROLLBACK
// ============================================================================

function rollback() {
  log('Looking for backup to restore...', 'info');
  
  const backups = fs.readdirSync('.')
    .filter(f => f.startsWith('.migration-backup-'))
    .sort()
    .reverse();
  
  if (backups.length === 0) {
    log('No backup found!', 'error');
    process.exit(1);
  }
  
  const latestBackup = backups[0];
  log(`Restoring from: ${latestBackup}`, 'info');
  
  // Remove new structure
  const newDirs = ['mcp-server', 'taskpane', 'websocket-server', 'certificates', 'electron', 'output'];
  for (const dir of newDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`Removed: ${dir}`, 'success');
    }
  }
  
  // Restore from backup
  const entries = fs.readdirSync(latestBackup);
  for (const entry of entries) {
    const src = path.join(latestBackup, entry);
    const dest = entry;
    
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
  
  log('Rollback complete!', 'success');
  log(`Backup ${latestBackup} preserved (delete manually when ready)`, 'info');
}

// ============================================================================
// ENTRY POINT
// ============================================================================

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║     PieceMaker Codebase Migration Tool                 ║');
console.log('╚════════════════════════════════════════════════════════╝');
console.log('');

if (ROLLBACK) {
  rollback();
} else {
  migrate();
}
