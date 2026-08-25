import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PROVIDER_ID,
  configureClaudeCodeProxy,
  configureCodexProxy,
  installLitellmDependencies,
  litellmLaunchAgentPlist,
  litellmUrls,
  llmClientProxyStatus,
} from '../installer/lib/litellm-proxy.mjs';

function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-litellm-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Claude Code reçoit ANTHROPIC_BASE_URL sans perdre ses hooks ni ses réglages', (t) => {
  const userHome = temporaryHome(t);
  const directory = path.join(userHome, '.claude');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'settings.json'), `${JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo tiers' }] }] },
    env: { VARIABLE_TIERCE: 'conservée' },
  }, null, 2)}\n`);

  const first = configureClaudeCodeProxy({ baseUrl: 'http://127.0.0.1:44000/anthropic', userHome });
  const second = configureClaudeCodeProxy({ baseUrl: 'http://127.0.0.1:44000/anthropic', userHome });
  const settings = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(settings.model, 'opus');
  assert.equal(settings.env.VARIABLE_TIERCE, 'conservée');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:44000/anthropic');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo tiers');
});

test('Claude Code conserve un proxy tiers explicite et signale le conflit', (t) => {
  const userHome = temporaryHome(t);
  const directory = path.join(userHome, '.claude');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example"}}\n');

  const result = configureClaudeCodeProxy({ baseUrl: 'http://127.0.0.1:4000/anthropic', userHome });
  assert.equal(result.conflict, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL, 'https://gateway.example');
});

test('Claude Code ne remplace pas une section env invalide', (t) => {
  const userHome = temporaryHome(t);
  const directory = path.join(userHome, '.claude');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'settings.json'), '{"env":"géré ailleurs"}\n');

  const result = configureClaudeCodeProxy({ baseUrl: 'http://127.0.0.1:4000/anthropic', userHome });
  assert.equal(result.reason, 'env-invalid');
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), '{"env":"géré ailleurs"}\n');
});

test('Codex utilise le pass-through ChatGPT HTTP sans WebSocket et préserve le TOML', (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "gpt-test"',
    'approval_policy = "on-request"',
    '',
    '[mcp_servers.tiers]',
    'command = "serveur-tiers"',
    '',
  ].join('\n'));

  const first = configureCodexProxy({ baseUrl: 'http://127.0.0.1:44000/chatgpt', codexHome });
  const second = configureCodexProxy({ baseUrl: 'http://127.0.0.1:44000/chatgpt', codexHome });
  const content = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.match(content, new RegExp(`model_provider = "${CODEX_PROVIDER_ID}"`));
  assert.match(content, new RegExp(`\\[model_providers\\.${CODEX_PROVIDER_ID}\\]`));
  assert.match(content, /name = "PieceMaker · LiteLLM"/);
  assert.match(content, /base_url = "http:\/\/127\.0\.0\.1:44000\/chatgpt"/);
  assert.match(content, /requires_openai_auth = true/);
  assert.match(content, /supports_websockets = false/);
  assert.match(content, /model = "gpt-test"/);
  assert.match(content, /\[mcp_servers\.tiers\]\ncommand = "serveur-tiers"/);
});

test('Codex ne remplace jamais un fournisseur tiers déjà sélectionné', (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const original = 'model_provider = "entreprise"\n[model_providers.entreprise]\nbase_url = "https://gateway.example"\n';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), original);

  const result = configureCodexProxy({ baseUrl: 'http://127.0.0.1:4000/chatgpt', codexHome });
  assert.equal(result.conflict, true);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), original);
});

test('le statut reconnaît les deux clients routés par PieceMaker', (t) => {
  const userHome = temporaryHome(t);
  const config = { litellmPort: 44000 };
  configureClaudeCodeProxy({ baseUrl: litellmUrls(config).claude, userHome });
  configureCodexProxy({ baseUrl: litellmUrls(config).codex, codexHome: path.join(userHome, '.codex') });
  assert.deepEqual(
    { ...llmClientProxyStatus({ config, userHome }), claudeFile: undefined, codexFile: undefined },
    { claude: true, codex: true, claudeFile: undefined, codexFile: undefined },
  );
});

test('le LaunchAgent ne contient aucun secret fournisseur', (t) => {
  const userHome = temporaryHome(t);
  const homeDir = path.join(userHome, '.piecemaker');
  const repoRoot = path.join(userHome, 'PieceMaker & Cabinet');
  const plist = litellmLaunchAgentPlist({
    config: { litellmPort: 44000, litellmVenvPath: path.join(homeDir, 'litellm-venv') },
    homeDir,
    repoRoot,
    userHome,
  });

  assert.match(plist, /com\.piecemaker\.litellm/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /PieceMaker &amp; Cabinet/);
  assert.match(plist, /<key>PROXY_PORT<\/key>\s*<string>44000<\/string>/);
  assert.doesNotMatch(plist, /ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|LITELLM_MASTER_KEY/);
});

test('l’installation pip est asynchrone et revalide LiteLLM', async (t) => {
  const userHome = temporaryHome(t);
  const homeDir = path.join(userHome, '.piecemaker');
  const venvDir = path.join(homeDir, 'litellm-venv');
  const python = path.join(venvDir, 'bin', 'python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  let probeCount = 0;
  let pipArgs = null;
  const runCapture = (_command, args) => {
    if (args.some((arg) => String(arg).includes("print(version('litellm'))"))) {
      return { code: 0, stdout: '1.98.1', stderr: '' };
    }
    probeCount += 1;
    return { code: probeCount === 1 ? 1 : 0, stdout: '', stderr: '' };
  };
  const runCommand = async (_command, args, options) => {
    pipArgs = args;
    options.onLine('Installation locale');
    return 0;
  };

  const result = await installLitellmDependencies({
    config: { litellmVenvPath: venvDir },
    homeDir,
    repoRoot: userHome,
    userHome,
    runCapture,
    runCommand,
  });
  assert.equal(result.changed, true);
  assert.equal(result.version, '1.98.1');
  assert.deepEqual(pipArgs.slice(0, 4), ['-m', 'pip', 'install', '--disable-pip-version-check']);
});
