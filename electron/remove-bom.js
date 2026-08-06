#!/usr/bin/env node
/**
 * Script pour enlever les BOM (Byte Order Mark) de tous les fichiers JS
 * Nécessaire pour Windows où certains éditeurs ajoutent des BOM UTF-8
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

function removeBOM(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Vérifier si le fichier commence par un BOM (U+FEFF)
  if (content.charCodeAt(0) === 0xFEFF) {
    const cleanContent = content.slice(1);
    fs.writeFileSync(filePath, cleanContent, 'utf8');
    console.log(`✅ BOM supprimé de: ${filePath}`);
    return true;
  }
  return false;
}

// Nettoyer uniquement le dossier addon (source)
const pattern = 'taskpane/**/*.js';
const files = glob.sync(pattern, { nodir: true });

console.log(`\n🔍 Recherche dans: ${pattern}`);
console.log(`   Fichiers trouvés: ${files.length}`);

let totalCleaned = 0;

files.forEach(file => {
  if (removeBOM(file)) {
    totalCleaned++;
  }
});

console.log(`\n✅ Total de fichiers nettoyés: ${totalCleaned}`);

if (totalCleaned === 0) {
  console.log('✅ Aucun BOM trouvé - tous les fichiers sont OK');
} else {
  console.log(`\n⚠️  Transférez maintenant le dossier taskpane/ vers Windows`);
}
