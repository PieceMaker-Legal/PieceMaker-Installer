import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, install, meta } from '../installer/steps/09-codex-plugin.mjs';
import {
  codexSkillStatus,
  registerCodexSkill,
  repositoryCodexSkills,
  syncCodexSkills,
} from '../installer/lib/codex-skills.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-codex-skills-'));
  const repo = path.join(root, 'repo');
  const userHome = path.join(root, 'user');
  const skill = path.join(repo, 'piecemaker-plugin', 'skills', 'anonymisation');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: anonymisation\n---\n');
  return { root, repo, userHome };
}

function fakeRuntime(overrides = {}) {
  return {
    commandExists: () => true,
    existsSync: () => true,
    userHome: '/tmp/codex-user',
    log: { info() {}, detail() {}, warn() {} },
    repositoryCodexSkills: () => ['piecemaker-plugin/skills/anonymisation/SKILL.md'],
    codexSkillStatus: () => ({ state: 'linked' }),
    syncCodexSkills: () => ({ registered: 1, conflicts: [] }),
    loadConfig: () => ({ caseFolders: [] }),
    refreshRegisteredCaseRules: () => ({ refreshed: 0, failed: [] }),
    ...overrides,
  };
}

test('l’étape Codex est optionnelle et ne déclare aucun plugin d’application', () => {
  assert.equal(meta.id, '09-codex-plugin');
  assert.equal(meta.required, false);
  assert.match(meta.label, /Skills Codex/);
});

test('les skills du plugin sont enregistrés dans ~/.codex/skills', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  assert.deepEqual(repositoryCodexSkills(data.repo), ['piecemaker-plugin/skills/anonymisation/SKILL.md']);
  const result = syncCodexSkills(data.repo, data.userHome);
  assert.equal(result.registered, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(codexSkillStatus(
    data.repo,
    data.userHome,
    'piecemaker-plugin/skills/anonymisation/SKILL.md',
  ).state, 'linked');
});

test('un skill Codex personnel homonyme n’est jamais remplacé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = path.join(data.userHome, '.codex', 'skills', 'anonymisation');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), '# personnel\n');

  const result = registerCodexSkill(
    data.repo,
    data.userHome,
    'piecemaker-plugin/skills/anonymisation/SKILL.md',
  );
  assert.equal(result.state, 'conflict');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), '# personnel\n');
});

test('l’absence de la CLI Codex laisse l’installateur intact', async () => {
  const runtime = fakeRuntime({ commandExists: () => false });
  assert.deepEqual(await install({ dryRun: false }, runtime), {
    status: 'skipped',
    note: 'CLI "codex" introuvable.',
  });
});

test('le dry-run ne synchronise aucun skill', async () => {
  let synchronized = false;
  const runtime = fakeRuntime({ syncCodexSkills: () => { synchronized = true; } });
  assert.equal((await install({ dryRun: true }, runtime)).status, 'skipped');
  assert.equal(synchronized, false);
});

test('l’installation et le diagnostic confirment les skills CLI enregistrés', async () => {
  const runtime = fakeRuntime();
  assert.equal((await install({ dryRun: false }, runtime)).status, 'done');
  assert.deepEqual(await check({}, runtime), { status: 'done', note: '' });
});

test('les conflits restent partiels et ne cassent pas l’installation globale', async () => {
  const runtime = fakeRuntime({
    syncCodexSkills: () => ({ registered: 0, conflicts: [{ slug: 'anonymisation' }] }),
  });
  assert.equal((await install({ dryRun: false }, runtime)).status, 'partial');
});
