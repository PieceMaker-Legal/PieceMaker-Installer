/**
 * Enregistrement direct des hooks PieceMaker dans Claude Code.
 *
 * Le fichier piecemaker-plugin/hooks/hooks.json reste la source des événements
 * et matchers, mais aucun manifest ni cache de plugin Claude n'est utilisé.
 * Les commandes sont matérialisées avec le chemin absolu du dépôt puis
 * fusionnées dans ~/.claude/settings.json sans toucher aux hooks personnels.
 */

const fs = require('fs');
const path = require('path');

function settingsPath(userHome) {
  return path.join(userHome, '.claude', 'settings.json');
}

function sourcePath(repoRoot) {
  return path.join(repoRoot, 'piecemaker-plugin', 'hooks', 'hooks.json');
}

function readJson(file, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function commandScriptName(command) {
  const match = String(command || '').match(/[\\/]piecemaker-plugin[\\/]scripts[\\/]([^\\/"']+\.mjs)/);
  return match?.[1] || '';
}

function directHookGroups(repoRoot) {
  const source = readJson(sourcePath(repoRoot));
  if (!source?.hooks || typeof source.hooks !== 'object') return null;
  const escapedRoot = path.join(repoRoot, 'piecemaker-plugin').replaceAll('"', '\\"');
  return Object.fromEntries(Object.entries(source.hooks).map(([event, groups]) => [
    event,
    (Array.isArray(groups) ? groups : []).map((group) => ({
      ...group,
      hooks: (Array.isArray(group?.hooks) ? group.hooks : []).map((hook) => ({
        ...hook,
        command: typeof hook?.command === 'string'
          ? hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', escapedRoot)
          : hook?.command,
      })),
    })),
  ]));
}

function expectedCommands(repoRoot) {
  const groups = directHookGroups(repoRoot);
  if (!groups) return null;
  return Object.entries(groups).flatMap(([event, entries]) => entries.flatMap((group) =>
    group.hooks
      .filter((hook) => typeof hook?.command === 'string' && commandScriptName(hook.command))
      .map((hook) => ({ event, matcher: group.matcher, command: hook.command, script: commandScriptName(hook.command) })),
  ));
}

function findHook(settings, event, script) {
  const groups = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  for (const group of groups) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    const hook = hooks.find((entry) => commandScriptName(entry?.command) === script);
    if (hook) return { group, hook };
  }
  return null;
}

function claudeHooksStatus(repoRoot, userHome) {
  const expected = expectedCommands(repoRoot);
  if (!expected) return { ok: false, reason: 'source-hooks-absent', missing: [] };
  const settings = readJson(settingsPath(userHome), {});
  const missing = expected.filter((entry) => {
    const current = findHook(settings, entry.event, entry.script);
    return current?.hook.command !== entry.command
      || current?.hook.type !== 'command'
      || current?.group.matcher !== entry.matcher;
  });
  return { ok: missing.length === 0, expected: expected.length, missing };
}

function installClaudeHooks(repoRoot, userHome) {
  const expected = expectedCommands(repoRoot);
  if (!expected) {
    return { ok: false, changed: false, reason: `Configuration de hooks introuvable : ${sourcePath(repoRoot)}` };
  }

  const target = settingsPath(userHome);
  let settings = {};
  if (fs.existsSync(target)) {
    settings = readJson(target);
    if (!settings) {
      return { ok: false, changed: false, reason: `${target} contient un JSON invalide et n'a pas été modifié.` };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};

  let changed = false;
  let registered = 0;
  for (const entry of expected) {
    if (!Array.isArray(settings.hooks[entry.event])) settings.hooks[entry.event] = [];
    const current = findHook(settings, entry.event, entry.script);
    if (current) {
      if (current.hook.command !== entry.command) {
        current.hook.command = entry.command;
        changed = true;
      }
      if (current.hook.type !== 'command') {
        current.hook.type = 'command';
        changed = true;
      }
      if (current.group.matcher !== entry.matcher) {
        current.group.matcher = entry.matcher;
        changed = true;
      }
      registered += 1;
      continue;
    }
    settings.hooks[entry.event].push({
      matcher: entry.matcher,
      hooks: [{ type: 'command', command: entry.command }],
    });
    changed = true;
    registered += 1;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
  return { ok: true, changed, registered, settings: target };
}

module.exports = {
  claudeHooksStatus,
  directHookGroups,
  installClaudeHooks,
  settingsPath,
};
