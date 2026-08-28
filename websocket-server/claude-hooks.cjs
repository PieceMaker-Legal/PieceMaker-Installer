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

const DEPRECATED_MAPPING_HOOKS = new Set([
  'anonymize-read.mjs',
  'deanonymize-write.mjs',
  'piecemaker-central-anonymize.mjs',
]);

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

function deprecatedMappingHookName(command) {
  const text = String(command || '');
  return [...DEPRECATED_MAPPING_HOOKS].find((name) => text.includes(name)) || '';
}

function deprecatedMappingHooks(settings) {
  if (!settings?.hooks || typeof settings.hooks !== 'object') return [];
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : [])
        .map((hook) => ({ event, command: hook?.command, script: deprecatedMappingHookName(hook?.command) }))
        .filter((entry) => entry.script),
    ),
  );
}

/** Retire les anciens hooks de substitution, remplacés par le proxy PII. */
function removeDeprecatedMappingHooks(userHome) {
  const target = settingsPath(userHome);
  let changed = false;
  let removed = 0;

  if (fs.existsSync(target)) {
    const settings = readJson(target);
    if (!settings) return { ok: false, changed: false, removed: 0, reason: 'invalid-settings' };
    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const [event, groups] of Object.entries(settings.hooks)) {
        if (!Array.isArray(groups)) continue;
        const cleanedGroups = [];
        let eventChanged = false;
        for (const group of groups) {
          if (!Array.isArray(group?.hooks)) {
            cleanedGroups.push(group);
            continue;
          }
          const hooks = group.hooks;
          const kept = hooks.filter((hook) => !deprecatedMappingHookName(hook?.command));
          const removedFromGroup = hooks.length - kept.length;
          removed += removedFromGroup;
          eventChanged ||= removedFromGroup > 0;
          if (kept.length) cleanedGroups.push({ ...group, hooks: kept });
        }
        if (eventChanged) settings.hooks[event] = cleanedGroups;
      }
    }
    if (removed) {
      fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      changed = true;
    }
  }

  const staleFile = path.join(userHome, '.claude', 'hooks', 'piecemaker-central-anonymize.mjs');
  let deletedFile = false;
  try {
    if (fs.existsSync(staleFile)) {
      fs.unlinkSync(staleFile);
      deletedFile = true;
      changed = true;
    }
  } catch {
    return { ok: false, changed, removed, deletedFile: false, reason: 'delete-failed' };
  }

  return { ok: true, changed, removed, deletedFile, settings: target };
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
      .map((hook) => ({
        event,
        matcher: group.matcher,
        command: hook.command,
        script: commandScriptName(hook.command),
        timeout: hook.timeout,
      })),
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
  const deprecated = deprecatedMappingHooks(settings);
  const missing = expected.filter((entry) => {
    const current = findHook(settings, entry.event, entry.script);
    return current?.hook.command !== entry.command
      || current?.hook.type !== 'command'
      || current?.group.matcher !== entry.matcher
      || current?.hook.timeout !== entry.timeout;
  });
  return { ok: missing.length === 0 && deprecated.length === 0, expected: expected.length, missing, deprecated };
}

function installClaudeHooks(repoRoot, userHome) {
  const cleanup = removeDeprecatedMappingHooks(userHome);
  if (!cleanup.ok) {
    return { ok: false, changed: cleanup.changed, reason: `Nettoyage des anciens hooks de mapping impossible : ${cleanup.reason}` };
  }
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
      if (current.hook.timeout !== entry.timeout) {
        if (entry.timeout === undefined) delete current.hook.timeout;
        else current.hook.timeout = entry.timeout;
        changed = true;
      }
      registered += 1;
      continue;
    }
    const newHook = { type: 'command', command: entry.command };
    if (entry.timeout !== undefined) newHook.timeout = entry.timeout;
    settings.hooks[entry.event].push({
      matcher: entry.matcher,
      hooks: [newHook],
    });
    changed = true;
    registered += 1;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
  return { ok: true, changed: changed || cleanup.changed, registered, settings: target, cleanup };
}

/**
 * statusLine Claude Code — même logique de matérialisation que les hooks,
 * mais pour une clé unique de settings.json (`statusLine`) plutôt qu'un
 * tableau. Une statusLine personnelle (non-PieceMaker) n'est jamais touchée.
 */
function statusLineScriptPath(repoRoot) {
  return path.join(repoRoot, 'piecemaker-plugin', 'scripts', 'statusline.mjs');
}

function statusLineCommand(repoRoot) {
  return `node "${statusLineScriptPath(repoRoot).replaceAll('"', '\\"')}"`;
}

/** Une statusLine nous appartient si sa commande cite bien notre script. */
function isOwnStatusLine(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.command === 'string'
    && value.command.includes('piecemaker-plugin')
    && value.command.includes('statusline.mjs');
}

function claudeStatusLineStatus(repoRoot, userHome) {
  const command = statusLineCommand(repoRoot);
  const target = settingsPath(userHome);
  if (!fs.existsSync(target)) {
    return { ok: false, installed: false, conflict: false, reason: 'settings-absent', command };
  }
  const settings = readJson(target);
  if (!settings) {
    return { ok: false, installed: false, conflict: false, reason: 'settings-invalid', command };
  }
  const current = settings.statusLine;
  if (current === undefined) {
    return { ok: false, installed: false, conflict: false, reason: 'absent', command };
  }
  if (!isOwnStatusLine(current)) {
    return { ok: false, installed: false, conflict: true, reason: 'statusline-etrangere', command };
  }
  const upToDate = current.type === 'command' && current.command === command;
  return { ok: upToDate, installed: true, conflict: false, reason: upToDate ? '' : 'chemin-perime', command };
}

function installClaudeStatusLine(repoRoot, userHome) {
  const command = statusLineCommand(repoRoot);
  const target = settingsPath(userHome);

  let settings = {};
  if (fs.existsSync(target)) {
    settings = readJson(target);
    if (!settings) {
      return { ok: false, changed: false, conflict: false, reason: 'settings-invalid', command, settings: target };
    }
  }

  const current = settings.statusLine;
  if (current !== undefined && !isOwnStatusLine(current)) {
    return { ok: true, changed: false, conflict: true, reason: 'statusline-etrangere', command, settings: target };
  }

  const desired = { type: 'command', command };
  if (current && current.type === desired.type && current.command === desired.command) {
    return { ok: true, changed: false, conflict: false, reason: '', command, settings: target };
  }

  settings.statusLine = desired;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { ok: true, changed: true, conflict: false, reason: '', command, settings: target };
}

module.exports = {
  claudeHooksStatus,
  claudeStatusLineStatus,
  directHookGroups,
  installClaudeHooks,
  installClaudeStatusLine,
  removeDeprecatedMappingHooks,
  settingsPath,
};
