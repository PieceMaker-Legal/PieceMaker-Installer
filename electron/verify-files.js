#!/usr/bin/env node
/**
 * Script pour vérifier que les fichiers JS sont bien du JavaScript et pas du HTML
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

console.log('=== Vérification intégrité fichiers taskpane/ ===\n');

const files = glob.sync('taskpane/**/*.js', { nodir: true });
let corrupted = 0;
let valid = 0;

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const firstLine = content.split('\n')[0].trim();

  // Vérifier si le fichier commence par du HTML
  if (firstLine.toLowerCase().includes('<!doctype') ||
      firstLine.toLowerCase().includes('<html') ||
      firstLine.toLowerCase().includes('<?xml')) {
    console.log(`❌ CORROMPU (HTML): ${file}`);
    console.log(`   Première ligne: ${firstLine.substring(0, 60)}...\n`);
    corrupted++;
  } else {
    console.log(`✅ OK: ${file}`);
    console.log(`   Première ligne: ${firstLine.substring(0, 60)}...\n`);
    valid++;
  }
});

console.log('===========================================');
console.log(`✅ Fichiers valides: ${valid}`);
console.log(`❌ Fichiers corrompus: ${corrupted}`);

if (corrupted > 0) {
  console.log('\n⚠️  ATTENTION: Des fichiers sont corrompus!');
  console.log('   Ces fichiers contiennent du HTML au lieu de JavaScript.');
  console.log('   Ne les transférez PAS vers Windows dans cet état.\n');
  process.exit(1);
} else {
  console.log('\n✅ Tous les fichiers sont valides - prêts pour le transfert\n');
}
