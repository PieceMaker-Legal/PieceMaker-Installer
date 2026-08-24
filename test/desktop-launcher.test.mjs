import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  desktopLauncherStatus,
  installDesktopLauncher,
} from '../installer/lib/desktop-launcher.mjs';
import { meta } from '../installer/steps/15-pwa-desktop.mjs';

test('le raccourci PWA est une étape optionnelle proposée par l’installateur', () => {
  assert.equal(meta.id, '15-pwa-desktop');
  assert.equal(meta.required, false);
  const icns = fs.readFileSync(path.resolve('installer/assets/piecemaker.icns'));
  const ico = fs.readFileSync(path.resolve('installer/assets/piecemaker.ico'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
});

test('le raccourci macOS ouvre PieceMaker et le protocole hors ligne démarre seulement le serveur', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-desktop-launcher-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const repoRoot = path.join(homeDir, 'PieceMaker');
  const desktopDir = path.join(homeDir, 'Desktop');
  const runtimeDir = path.join(homeDir, '.piecemaker');
  const iconPath = path.join(homeDir, 'piecemaker.icns');
  fs.mkdirSync(path.join(repoRoot, 'installer', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'installer', 'bin', 'piecemaker.mjs'), '');
  fs.writeFileSync(iconPath, 'icône factice');
  const calls = [];

  const result = installDesktopLauncher({
    platform: 'darwin',
    homeDir,
    runtimeDir,
    repoRoot,
    desktopDir,
    nodePath: '/opt/piecemaker/node',
    iconPath,
    commandRunner(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const desktopScript = fs.readFileSync(path.join(result.shortcut, 'Contents', 'MacOS', 'PieceMaker'), 'utf8');
  const protocolScript = fs.readFileSync(path.join(result.protocol, 'Contents', 'MacOS', 'PieceMaker'), 'utf8');
  const protocolPlist = fs.readFileSync(path.join(result.protocol, 'Contents', 'Info.plist'), 'utf8');
  assert.match(desktopScript, /piecemaker\.mjs' open/);
  assert.match(protocolScript, /piecemaker\.mjs' start/);
  assert.match(protocolPlist, /<string>piecemaker<\/string>/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-f', result.protocol]);
  assert.deepEqual(desktopLauncherStatus({ platform: 'darwin', homeDir, runtimeDir, desktopDir }), {
    shortcut: result.shortcut,
    protocol: result.protocol,
    shortcutReady: true,
    protocolReady: true,
  });
});

test('les entrées Linux séparent aussi open et start', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-desktop-linux-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const repoRoot = path.join(homeDir, 'PieceMaker');
  const desktopDir = path.join(homeDir, 'Desktop');
  const iconPath = path.join(homeDir, 'icon.png');
  fs.mkdirSync(path.join(repoRoot, 'installer', 'bin'), { recursive: true });
  fs.writeFileSync(iconPath, 'icône factice');

  const result = installDesktopLauncher({
    platform: 'linux',
    homeDir,
    repoRoot,
    desktopDir,
    nodePath: '/usr/bin/node',
    iconPath,
    commandRunner: () => ({ code: 0, stdout: '', stderr: '' }),
  });

  assert.match(fs.readFileSync(result.shortcut, 'utf8'), /piecemaker\.mjs" open/);
  assert.match(fs.readFileSync(result.protocol, 'utf8'), /piecemaker\.mjs" start/);
  assert.equal(result.protocolReady, true);
});

test('Windows crée un raccourci open et enregistre un protocole start', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-desktop-windows-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const repoRoot = path.join(homeDir, 'PieceMaker');
  const desktopDir = path.join(homeDir, 'Desktop');
  const iconPath = path.join(homeDir, 'icon.ico');
  fs.writeFileSync(iconPath, 'icône factice');
  const calls = [];

  const result = installDesktopLauncher({
    platform: 'win32',
    homeDir,
    repoRoot,
    desktopDir,
    nodePath: 'C:\\PieceMaker\\node.exe',
    iconPath,
    commandRunner(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const powershell = calls.find(({ command }) => command === 'powershell.exe');
  const registry = calls.filter(({ command }) => command === 'reg.exe');
  assert.match(powershell.args.at(-1), /piecemaker\.mjs" open/);
  assert.match(registry.at(-1).args.join(' '), /piecemaker\.mjs" start/);
  assert.equal(result.protocolReady, true);
});
