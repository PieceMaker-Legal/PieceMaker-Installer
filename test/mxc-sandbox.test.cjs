/**
 * mxc-sandbox.test.cjs — the OS-level filesystem sandbox policy generator.
 *
 * Two layers:
 *   - Unit (runs everywhere): the policy denies the venv, the central mapping
 *     and every case mapping file on macOS/Linux, and the Windows allowlist
 *     never grants a mapping/venv path. No mxc binary needed.
 *   - Enforcement (macOS, auto-skipped when no binary is installed): a real mxc
 *     run refuses to read a denied fixture — including via `python3 -c` and
 *     `find -exec cat`, the exact vectors a PreToolUse hook could not stop.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Hermetic home: must be set before requiring the module (PIECEMAKER_HOME is
// captured at load time for centralMappingPath()/venvPath()).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mxc-home-'));
process.env.PIECEMAKER_HOME = TEST_HOME;
delete process.env.PIECEMAKER_MXC_DISABLE;

const mxc = require('../websocket-server/mxc-sandbox.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

/** A case tree with mapping files in every place the pipeline can leave them. */
function makeCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mxc-case-'));
  const workspace = path.join(root, WORKSPACE_SUBDIR);
  const dot = path.join(root, '.piecemaker');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dot, { recursive: true });
  const canonical = path.join(workspace, 'mapping_default.json');
  const legacy = path.join(root, 'mapping_dossier.json');
  const sensitive = path.join(workspace, 'piece1_sensitive_map.json');
  const readable = path.join(workspace, 'piece1.md');
  for (const f of [canonical, legacy, sensitive]) fs.writeFileSync(f, '{}');
  fs.writeFileSync(readable, '# clear markdown');
  return { root, workspace, dot, canonical, legacy, sensitive, readable };
}

test('deniedPathsFor blocks the venv, the central mapping and every case mapping', () => {
  const c = makeCase();
  const denied = mxc.deniedPathsFor({
    documentId: c.root,
    config: {},
    resolveCaseRoot: () => c.root,
  });

  assert.ok(denied.includes(path.resolve(TEST_HOME, 'venv')), 'venv denied');
  assert.ok(denied.includes(path.resolve(mxc.centralMappingPath())), 'central mapping denied');
  assert.ok(denied.includes(path.resolve(c.canonical)), 'canonical case mapping denied');
  assert.ok(denied.includes(path.resolve(c.legacy)), 'legacy case mapping denied');
  assert.ok(denied.includes(path.resolve(c.sensitive)), 'sensitive map denied');
  // The readable .md the agent must reach is never denied.
  assert.ok(!denied.includes(path.resolve(c.readable)), 'readable .md not denied');
});

test('deniedPathsFor respects config.venvPath override', () => {
  const custom = path.join(TEST_HOME, 'custom-venv');
  const denied = mxc.deniedPathsFor({ config: { venvPath: custom } });
  assert.ok(denied.includes(path.resolve(custom)));
});

test('deniedPathsFor denies the canonical mapping even before the file exists', () => {
  // A fresh case with no mapping file yet: the path is still denied so a file
  // created mid-session is covered (Seatbelt rules are path-based).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mxc-empty-'));
  const denied = mxc.deniedPathsFor({
    documentId: root,
    config: {},
    resolveCaseRoot: () => root,
  });
  const expected = path.resolve(root, WORKSPACE_SUBDIR, 'mapping_default.json');
  assert.ok(denied.includes(expected), 'canonical mapping denied pre-creation');
});

test('caseMappingPaths enumerates mapping*.json and *_sensitive_map.json', () => {
  const c = makeCase();
  const paths = mxc.caseMappingPaths(c.root).map((p) => path.basename(p));
  assert.ok(paths.includes('mapping_default.json'));
  assert.ok(paths.includes('mapping_dossier.json'));
  assert.ok(paths.includes('piece1_sensitive_map.json'));
  assert.ok(!paths.includes('piece1.md'), 'never lists the readable markdown');
});

test('buildSandboxConfig emits a Seatbelt deny policy on macOS/Linux', (t) => {
  if (!mxc.supportsDeny()) return t.skip('deny-all-except is macOS/Linux only');
  const c = makeCase();
  // A fake binary so mxcBinaryPath() resolves without a real mxc install.
  const fakeBin = path.join(TEST_HOME, 'mxc-exec-fake');
  fs.writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 });

  const sandbox = mxc.buildSandboxConfig({
    shell: '/bin/zsh',
    cwd: c.root,
    documentId: c.root,
    env: { PATH: '/usr/bin', EMPTY: undefined },
    config: { mxcPath: fakeBin },
    resolveCaseRoot: () => c.root,
  });

  assert.ok(sandbox, 'sandbox built');
  assert.equal(sandbox.mxcPath, fakeBin);
  assert.deepEqual(sandbox.args, [sandbox.configPath]);

  const cfg = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));
  assert.equal(cfg.version, mxc.MXC_SCHEMA_VERSION);
  assert.equal(cfg.process.commandLine, '/bin/zsh');
  assert.equal(cfg.process.cwd, c.root);
  assert.ok(cfg.filesystem.deniedPaths.includes(path.resolve(c.canonical)));
  assert.ok(!('readwritePaths' in cfg.filesystem), 'no allowlist on deny platforms');
  // undefined env values are dropped, defined ones passed as KEY=VALUE.
  assert.ok(cfg.process.env.includes('PATH=/usr/bin'));
  assert.ok(!cfg.process.env.some((e) => e.startsWith('EMPTY=')));
  // Network stays open so Claude reaches its API + localhost:43098.
  assert.equal(cfg.network.defaultPolicy, 'allow');

  sandbox.cleanup();
  assert.ok(!fs.existsSync(sandbox.configPath), 'temp policy cleaned up');
});

test('Windows allowlist never grants a mapping or the venv (by omission)', () => {
  // Re-require the module with process.platform forced to win32 so the
  // allowlist branch is exercised on this macOS host.
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  delete require.cache[require.resolve('../websocket-server/mxc-sandbox.cjs')];
  try {
    const winMxc = require('../websocket-server/mxc-sandbox.cjs');
    assert.equal(winMxc.supportsDeny(), false);
    assert.equal(winMxc.containmentBackend(), 'processcontainer');

    const c = makeCase();
    const fakeBin = path.join(TEST_HOME, 'wxc-exec-fake.exe');
    fs.writeFileSync(fakeBin, 'stub', { mode: 0o755 });

    const sandbox = winMxc.buildSandboxConfig({
      shell: 'cmd.exe',
      cwd: c.root,
      documentId: c.root,
      config: { mxcPath: fakeBin },
      resolveCaseRoot: () => c.root,
    });
    const cfg = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));

    const granted = [
      ...(cfg.filesystem.readwritePaths || []),
      ...(cfg.filesystem.readonlyPaths || []),
    ].map((p) => path.resolve(p));

    assert.ok(!('deniedPaths' in cfg.filesystem), 'no deniedPaths on Windows');
    // PIECEMAKER_HOME (venv + central mapping) is never granted.
    assert.ok(!granted.includes(path.resolve(TEST_HOME)), 'PIECEMAKER_HOME not granted');
    assert.ok(!granted.includes(path.resolve(winMxc.centralMappingPath())), 'central mapping not granted');
    // The case cwd IS granted (the agent must read its .md) — mapping_default
    // inside it stays hook-only, which is the documented Windows limit.
    assert.ok(granted.includes(path.resolve(c.root)), 'case cwd granted');

    sandbox.cleanup();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
    delete require.cache[require.resolve('../websocket-server/mxc-sandbox.cjs')];
  }
});

test('isMxcAvailable honours the escape hatch and the enabled flag', () => {
  const fakeBin = path.join(TEST_HOME, 'mxc-exec-hatch');
  fs.writeFileSync(fakeBin, 'stub', { mode: 0o755 });
  assert.equal(mxc.isMxcAvailable({ mxcPath: fakeBin }), true);
  assert.equal(mxc.isMxcAvailable({ mxcPath: fakeBin, mxcEnabled: false }), false);

  process.env.PIECEMAKER_MXC_DISABLE = '1';
  assert.equal(mxc.isMxcAvailable({ mxcPath: fakeBin }), false);
  delete process.env.PIECEMAKER_MXC_DISABLE;

  assert.equal(mxc.isMxcAvailable({ mxcPath: '/nope/does/not/exist' }), false);
});

// --- Enforcement (macOS, auto-skipped when no real binary is installed) -------

test('mxc actually refuses a denied file — cat, python3 -c and find -exec', (t) => {
  if (process.platform !== 'darwin') return t.skip('enforcement proof is macOS-only');
  const binary = mxc.mxcBinaryPath();
  if (!binary) return t.skip('no mxc binary installed (best-effort install step 14)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mxc-enforce-'));
  const secret = path.join(dir, 'secret.txt');
  const token = 'PIECEMAKER_MXC_CANARY_5R7';
  fs.writeFileSync(secret, token);

  const runDenied = (commandLine) => {
    const cfg = {
      version: mxc.MXC_SCHEMA_VERSION,
      containment: 'seatbelt',
      process: { commandLine, cwd: dir, env: [`PATH=${process.env.PATH}`], timeout: 0 },
      filesystem: { deniedPaths: [path.resolve(secret)] },
      network: { defaultPolicy: 'allow', allowLocalNetwork: true },
      seatbelt: { launchMethod: 'exec', nestedPty: false, keychainAccess: false, guiAccess: false },
    };
    const cfgPath = path.join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const res = spawnSync(binary, [cfgPath], { encoding: 'utf8', timeout: 30000 });
    return `${res.stdout || ''}${res.stderr || ''}`;
  };

  for (const cmd of [
    `cat ${JSON.stringify(secret)}`,
    `python3 -c "print(open(${JSON.stringify(secret)}).read())"`,
    `find ${JSON.stringify(dir)} -name secret.txt -exec cat {} +`,
  ]) {
    const output = runDenied(cmd);
    assert.ok(!output.includes(token), `token leaked via: ${cmd}\n${output}`);
  }

  // Control: a non-denied sibling file is still readable through mxc.
  const ok = path.join(dir, 'public.txt');
  fs.writeFileSync(ok, 'PUBLIC_OK');
  const okOutput = (() => {
    const cfg = {
      version: mxc.MXC_SCHEMA_VERSION,
      containment: 'seatbelt',
      process: { commandLine: `cat ${JSON.stringify(ok)}`, cwd: dir, env: [`PATH=${process.env.PATH}`], timeout: 0 },
      filesystem: { deniedPaths: [path.resolve(secret)] },
      network: { defaultPolicy: 'allow', allowLocalNetwork: true },
      seatbelt: { launchMethod: 'exec', nestedPty: false, keychainAccess: false, guiAccess: false },
    };
    const cfgPath = path.join(dir, 'policy-ok.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const res = spawnSync(binary, [cfgPath], { encoding: 'utf8', timeout: 30000 });
    return `${res.stdout || ''}${res.stderr || ''}`;
  })();
  assert.ok(okOutput.includes('PUBLIC_OK'), 'non-denied file must stay readable');
});
