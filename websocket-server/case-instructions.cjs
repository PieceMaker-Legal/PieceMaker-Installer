/** Instructions PieceMaker générées dans chaque dossier juridique enregistré. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registeredCaseFolders } = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');
const {
  historyRepo,
  resolveCase,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');

const IMPORT_START = '<!-- piecemaker-instructions-start -->';
const IMPORT_END = '<!-- piecemaker-instructions-end -->';

function caseHistoryRepoLabel(folder) {
  try {
    const legalCase = resolveCase(path.dirname(folder), path.basename(folder));
    const absolute = historyRepo(path.join(os.homedir(), '.piecemaker'), legalCase);
    const home = os.homedir();
    return absolute.startsWith(home + path.sep) ? `~${absolute.slice(home.length)}` : absolute;
  } catch {
    return '';
  }
}

function caseRuleContent(repoRoot, folder = '') {
  const template = path.join(repoRoot, 'installer', 'templates', 'workspace-CLAUDE.md');
  if (!fs.existsSync(template)) throw new Error('Le modèle d’instructions PieceMaker est introuvable.');
  let content = fs.readFileSync(template, 'utf8')
    .replace(
      '| Racine des dossiers | ce répertoire (`workspacePath` de `~/.piecemaker/config.json`) |',
      '| Dossier juridique actif | ce répertoire (`caseFolders` de `~/.piecemaker/config.json`) |',
    );

  const repoLabel = folder ? caseHistoryRepoLabel(folder) : '';
  if (repoLabel) {
    content = content.replace(
      '| Historique des dossiers | `~/.piecemaker/case-history/` |',
      `| Historique de ce dossier | \`${repoLabel}\` |`,
    );
  }
  return content;
}

function managedImportBlock(rule) {
  return `${IMPORT_START}\n@${rule}\n${IMPORT_END}`;
}

function ensureInstructionImport(file, rule) {
  const block = managedImportBlock(rule);
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {}

  const pattern = new RegExp(`${IMPORT_START}[\\s\\S]*?${IMPORT_END}\\n?`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, `${block}\n`)
    : `${block}\n\n${current || '# Ce dossier\n\n<!-- Instructions propres à ce dossier. -->\n'}`;
  if (next !== current) fs.writeFileSync(file, next, 'utf8');
}

function ensureCaseRule(repoRoot, folder) {
  const target = path.join(folder, '.claude', 'rules', 'piecemaker.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = caseRuleContent(repoRoot, folder);
  let previous = null;
  try { previous = fs.readFileSync(target, 'utf8'); } catch {}
  if (previous !== content) fs.writeFileSync(target, content, 'utf8');

  // Claude Code charge nativement .claude/rules ; les imports explicites
  // garantissent aussi la disponibilité depuis Codex/AGENTS.md et rendent la
  // règle visible à la racine sans écraser les consignes propres au dossier.
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    ensureInstructionImport(path.join(folder, name), target);
  }
  return target;
}

function refreshRegisteredCaseRules(repoRoot, config) {
  const result = { refreshed: 0, failed: [] };
  for (const folder of registeredCaseFolders(config)) {
    try {
      ensureCaseRule(repoRoot, folder);
      result.refreshed += 1;
    } catch (error) {
      result.failed.push({ folder, error: error.message });
    }
  }
  return result;
}

module.exports = {
  IMPORT_END,
  IMPORT_START,
  caseRuleContent,
  ensureCaseRule,
  ensureInstructionImport,
  refreshRegisteredCaseRules,
};
