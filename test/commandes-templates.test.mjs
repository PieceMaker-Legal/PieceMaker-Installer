/**
 * Test anti-dérive de la surface de commandes.
 *
 * Rien ne reliait jusqu'ici le binaire au texte qui le décrit : `COMMANDS`
 * n'était importé nulle part et les tests ne cherchaient qu'une sous-chaîne.
 * Une commande renommée aurait laissé les templates, le bloc géré et les
 * outils MCP en dérive silencieuse, et le modèle aurait appelé une commande
 * inexistante. On vérifie donc les deux sens.
 *
 * `installer/bin/piecemaker.mjs` n'est jamais importé : il lance `main()` dès
 * son chargement, ce qui ouvrirait le menu interactif et toucherait aux
 * services réels de la machine. La surface vit dans `installer/lib/commandes.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS, GRAPH_ACTIONS } from '../installer/lib/commandes.mjs';
import {
  chronologyArgs,
  conversionArgs,
  graphBuildArgs,
  graphQuestionArgs,
  graphStatusArgs,
} from '../mcp/piecemaker/server.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Les cinq outils du serveur MCP, réduits à la commande qu'ils lancent. */
const OUTILS = {
  graphe_question: graphQuestionArgs({ question: 'q', dossier: '/dossier' }),
  graphe_construire: graphBuildArgs({ dossier: '/dossier' }),
  graphe_etat: graphStatusArgs({ dossier: '/dossier' }),
  conversion: conversionArgs({ dossier: '/dossier' }),
  chronologie: chronologyArgs({ dossier: '/dossier' }),
};

/** Textes qui prescrivent des commandes au modèle ou à l'utilisateur. */
const TEXTES = [
  'installer/templates/root-CLAUDE.md',
  'installer/templates/workspace-CLAUDE.md',
  'websocket-server/case-instructions.cjs',
  'piecemaker-plugin/skills/graphe-juridique/SKILL.md',
  'piecemaker-plugin/agents/analyste-piece.md',
  'README.md',
];

test('chaque outil MCP lance une commande qui existe dans le binaire', () => {
  for (const [outil, args] of Object.entries(OUTILS)) {
    assert.ok(COMMANDS.has(args[0]), `${outil} lance « piecemaker ${args[0]} », commande inconnue`);
    if (args[0] === 'graph') {
      assert.ok(GRAPH_ACTIONS.has(args[1]), `${outil} lance « graph ${args[1]} », action inconnue`);
    }
  }
});

test('chaque commande piecemaker citée dans les textes existe dans le binaire', () => {
  const motif = /piecemaker ([a-z][a-z-]*)/g;
  let vues = 0;
  for (const relatif of TEXTES) {
    const contenu = fs.readFileSync(path.join(REPO_ROOT, relatif), 'utf8');
    for (const [, commande] of contenu.matchAll(motif)) {
      // « piecemaker » désigne aussi le serveur MCP et le dossier du dépôt :
      // on ne retient que les mots qui ressemblent à une commande.
      if (['mcp', 'instructions', 'plugin'].includes(commande)) continue;
      vues += 1;
      assert.ok(COMMANDS.has(commande), `${relatif} cite « piecemaker ${commande} », commande inconnue`);
    }
  }
  assert.ok(vues > 0, 'aucune commande citée : le motif de détection est cassé');
});

test('le bloc géré des dossiers cite les outils MCP, pas des commandes shell', () => {
  const { caseRuleContent, IMPORT_START, IMPORT_END } = require(
    path.join(REPO_ROOT, 'websocket-server', 'case-instructions.cjs'),
  );
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-derive-'));
  try {
    const regle = caseRuleContent(REPO_ROOT, dossier);
    for (const outil of Object.keys(OUTILS)) {
      if (outil === 'conversion') continue; // la conversion se pilote depuis l'administration
      assert.match(regle, new RegExp(`\`${outil}\``), `la règle de dossier ne cite pas l'outil ${outil}`);
    }
    assert.doesNotMatch(regle, /piecemaker (chronology|graph|conversion)/,
      'la règle de dossier prescrit encore une commande shell au lieu d\'un outil MCP');
    assert.ok(IMPORT_START && IMPORT_END);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
