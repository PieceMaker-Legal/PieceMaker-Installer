/**
 * Raccourci Bureau et gestionnaire du protocole local `piecemaker:`.
 *
 * Le raccourci lance `piecemaker open` : le serveur est donc démarré avant
 * l'ouverture de l'administration. Le gestionnaire de protocole, lui, lance
 * seulement `piecemaker start`; la page PWA hors ligne peut ainsi redémarrer
 * le serveur sans ouvrir une seconde fenêtre.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOME_DIR, REPO_ROOT, runCapture } from './platform.mjs';

const MAC_REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const DEFAULT_ICNS = path.join(REPO_ROOT, 'installer', 'assets', 'piecemaker.icns');
const DEFAULT_ICO = path.join(REPO_ROOT, 'installer', 'assets', 'piecemaker.ico');
const DEFAULT_PNG = path.join(REPO_ROOT, 'admin', 'icons', 'icon-512.png');
const SWIFT_SOURCE = path.join(REPO_ROOT, 'installer', 'assets', 'PieceMakerApp.swift');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function desktopEntryQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}

function commandSucceeded(result) {
  return !result?.error && result?.code === 0;
}

function writeFile(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode });
  fs.chmodSync(file, mode);
}

function desktopDirectoryForLinux(homeDir) {
  const config = path.join(homeDir, '.config', 'user-dirs.dirs');
  try {
    const match = fs.readFileSync(config, 'utf8').match(/^XDG_DESKTOP_DIR="([^"]+)"/m);
    if (match) return match[1].replace('$HOME', homeDir);
  } catch {}
  return path.join(homeDir, 'Desktop');
}

function resolveDesktopDirectory({ platform, homeDir, desktopDir, commandRunner }) {
  if (desktopDir) return desktopDir;
  if (platform === 'win32') {
    const result = commandRunner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Environment]::GetFolderPath("Desktop")',
    ]);
    if (commandSucceeded(result) && result.stdout) return result.stdout.trim();
  }
  if (platform === 'linux') return desktopDirectoryForLinux(homeDir);
  return path.join(homeDir, 'Desktop');
}

export function desktopLauncherPaths({
  platform = process.platform,
  homeDir = os.homedir(),
  runtimeDir = HOME_DIR,
  desktopDir,
  commandRunner = runCapture,
} = {}) {
  const desktop = resolveDesktopDirectory({ platform, homeDir, desktopDir, commandRunner });
  if (platform === 'darwin') {
    return {
      shortcut: path.join(desktop, 'PieceMaker.app'),
      protocol: path.join(runtimeDir, 'launcher', 'PieceMaker Protocol.app'),
    };
  }
  if (platform === 'win32') {
    return {
      shortcut: path.join(desktop, 'PieceMaker.lnk'),
      protocol: 'HKCU\\Software\\Classes\\piecemaker',
    };
  }
  return {
    shortcut: path.join(desktop, 'PieceMaker.desktop'),
    protocol: path.join(homeDir, '.local', 'share', 'applications', 'piecemaker-protocol.desktop'),
  };
}

function macPlist({ executable, identifier, protocol = false, nativeApp = false }) {
  const protocolBlock = protocol ? `
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>PieceMaker</string>
      <key>CFBundleURLSchemes</key><array><string>piecemaker</string></array>
    </dict>
  </array>` : '';
  const uiElement = nativeApp ? '' : '\n  <key>LSUIElement</key><true/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>PieceMaker</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIconFile</key><string>piecemaker.icns</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>${uiElement}${protocolBlock}
</dict>
</plist>
`;
}

function createMacShellApplication(target, {
  verb,
  identifier,
  protocol = false,
  nodePath,
  cliPath,
  runtimeDir,
  iconPath,
}) {
  const executable = 'PieceMaker';
  const contents = path.join(target, 'Contents');
  const executablePath = path.join(contents, 'MacOS', executable);
  const logPath = path.join(runtimeDir, 'desktop-launcher.log');
  const script = `#!/bin/sh\n${shellQuote(nodePath)} ${shellQuote(cliPath)} ${verb} >>${shellQuote(logPath)} 2>&1 &\nexit 0\n`;
  writeFile(executablePath, script, 0o755);
  writeFile(path.join(contents, 'Info.plist'), macPlist({ executable, identifier, protocol }));
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.copyFileSync(iconPath, path.join(contents, 'Resources', 'piecemaker.icns'));
}

function createMacNativeApplication(target, { identifier, nodePath, cliPath, iconPath, commandRunner }) {
  const executable = 'PieceMaker';
  const contents = path.join(target, 'Contents');
  const executablePath = path.join(contents, 'MacOS', executable);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  const compile = commandRunner('swiftc', [
    '-o', executablePath,
    '-framework', 'Cocoa',
    '-framework', 'WebKit',
    '-suppress-warnings',
    SWIFT_SOURCE,
  ]);
  if (!commandSucceeded(compile)) {
    throw new Error(`Compilation Swift impossible : ${compile.stderr || compile.error?.message || `code ${compile.code}`}`);
  }
  fs.chmodSync(executablePath, 0o755);
  const plist = macPlist({ executable, identifier, nativeApp: true });
  writeFile(path.join(contents, 'Info.plist'), plist);
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.copyFileSync(iconPath, path.join(contents, 'Resources', 'piecemaker.icns'));
  const envPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PIECEMAKER_NODE</key><string>${nodePath}</string>
  <key>PIECEMAKER_CLI</key><string>${cliPath}</string>
</dict>
</plist>
`;
  writeFile(path.join(contents, 'Resources', 'environment.plist'), envPlist);
}

function installMac({ paths, nodePath, cliPath, runtimeDir, iconPath, commandRunner }) {
  const swiftAvailable = commandSucceeded(commandRunner('which', ['swiftc']));
  if (swiftAvailable) {
    createMacNativeApplication(paths.shortcut, {
      identifier: 'com.piecemaker.desktop',
      nodePath,
      cliPath,
      iconPath,
      commandRunner,
    });
  } else {
    createMacShellApplication(paths.shortcut, {
      verb: 'open',
      identifier: 'com.piecemaker.desktop',
      nodePath,
      cliPath,
      runtimeDir,
      iconPath,
    });
  }
  createMacShellApplication(paths.protocol, {
    verb: 'start',
    identifier: 'com.piecemaker.protocol',
    protocol: true,
    nodePath,
    cliPath,
    runtimeDir,
    iconPath,
  });
  const registration = commandRunner(MAC_REGISTER, ['-f', paths.protocol]);
  return {
    native: swiftAvailable,
    protocolReady: commandSucceeded(registration),
    protocolError: registration.stderr || registration.error?.message || '',
  };
}

function installWindows({ paths, nodePath, cliPath, repoRoot, iconPath, commandRunner }) {
  fs.mkdirSync(path.dirname(paths.shortcut), { recursive: true });
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${powershellQuote(paths.shortcut)})`,
    `$shortcut.TargetPath = ${powershellQuote(nodePath)}`,
    `$shortcut.Arguments = ${powershellQuote(`"${cliPath}" open`)}`,
    `$shortcut.WorkingDirectory = ${powershellQuote(repoRoot)}`,
    `$shortcut.IconLocation = ${powershellQuote(`${iconPath},0`)}`,
    "$shortcut.Description = 'Démarrer et ouvrir PieceMaker'",
    '$shortcut.Save()',
  ].join('; ');
  const shortcut = commandRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!commandSucceeded(shortcut)) {
    throw new Error(shortcut.stderr || shortcut.error?.message || 'Création du raccourci Windows impossible.');
  }

  const key = 'HKCU\\Software\\Classes\\piecemaker';
  const protocolCommand = `"${nodePath}" "${cliPath}" start`;
  const commands = [
    [key, '/ve', '/d', 'URL:PieceMaker'],
    [key, '/v', 'URL Protocol', '/d', ''],
    [`${key}\\DefaultIcon`, '/ve', '/d', `"${iconPath}",0`],
    [`${key}\\shell\\open\\command`, '/ve', '/d', protocolCommand],
  ];
  const results = commands.map((args) => commandRunner('reg.exe', ['add', ...args, '/f']));
  const failure = results.find((result) => !commandSucceeded(result));
  return { protocolReady: !failure, protocolError: failure?.stderr || failure?.error?.message || '' };
}

function linuxDesktopEntry({ name, comment, nodePath, cliPath, verb, iconPath, protocol = false }) {
  return `[Desktop Entry]
Type=Application
Name=${name}
Comment=${comment}
Exec=${desktopEntryQuote(nodePath)} ${desktopEntryQuote(cliPath)} ${verb}
Icon=${iconPath}
Terminal=false
Categories=Office;Utility;
${protocol ? 'NoDisplay=true\nMimeType=x-scheme-handler/piecemaker;\n' : ''}`;
}

function installLinux({ paths, nodePath, cliPath, iconPath, commandRunner }) {
  writeFile(paths.shortcut, linuxDesktopEntry({
    name: 'PieceMaker',
    comment: 'Démarrer et ouvrir PieceMaker',
    nodePath,
    cliPath,
    verb: 'open',
    iconPath,
  }), 0o755);
  writeFile(paths.protocol, linuxDesktopEntry({
    name: 'PieceMaker Protocol',
    comment: 'Démarrer le serveur local PieceMaker',
    nodePath,
    cliPath,
    verb: 'start',
    iconPath,
    protocol: true,
  }), 0o755);
  const registration = commandRunner('xdg-mime', ['default', path.basename(paths.protocol), 'x-scheme-handler/piecemaker']);
  return { protocolReady: commandSucceeded(registration), protocolError: registration.stderr || registration.error?.message || '' };
}

export function installDesktopLauncher({
  platform = process.platform,
  homeDir = os.homedir(),
  runtimeDir = HOME_DIR,
  repoRoot = REPO_ROOT,
  desktopDir,
  nodePath = process.execPath,
  commandRunner = runCapture,
  iconPath,
} = {}) {
  const paths = desktopLauncherPaths({ platform, homeDir, runtimeDir, desktopDir, commandRunner });
  const cliPath = path.join(repoRoot, 'installer', 'bin', 'piecemaker.mjs');
  let result;
  if (platform === 'darwin') {
    result = installMac({ paths, nodePath, cliPath, runtimeDir, iconPath: iconPath || DEFAULT_ICNS, commandRunner });
  } else if (platform === 'win32') {
    result = installWindows({ paths, nodePath, cliPath, repoRoot, iconPath: iconPath || DEFAULT_ICO, commandRunner });
  } else {
    result = installLinux({ paths, nodePath, cliPath, iconPath: iconPath || DEFAULT_PNG, commandRunner });
  }
  return { ...paths, ...result };
}

export function desktopLauncherStatus(options = {}) {
  const paths = desktopLauncherPaths(options);
  const shortcutReady = fs.existsSync(paths.shortcut);
  const platform = options.platform || process.platform;
  const protocolReady = platform === 'win32'
    ? commandSucceeded((options.commandRunner || runCapture)('reg.exe', ['query', paths.protocol, '/v', 'URL Protocol']))
    : fs.existsSync(paths.protocol);
  return { ...paths, shortcutReady, protocolReady };
}
