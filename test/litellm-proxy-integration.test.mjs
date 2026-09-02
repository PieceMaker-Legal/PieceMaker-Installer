import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  CODEX_PROVIDER_ID,
  bypassClaudeCodeProxy,
  bypassCodexProxy,
  configureClaudeCodeProxy,
  configureCodexProxy,
  installLitellmDependencies,
  litellmLaunchAgentPlist,
  litellmProcessPid,
  litellmUrls,
  llmClientProxyStatus,
} from '../installer/lib/litellm-proxy.mjs';
import {
  codexSessionHookStatus,
  installCodexSessionHook,
} from '../installer/lib/codex-skills.mjs';

function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-litellm-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runHook(script, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
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

test('le bypass Claude retire seulement le routage PieceMaker', (t) => {
  const userHome = temporaryHome(t);
  const directory = path.join(userHome, '.claude');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'settings.json'), `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo tiers' }] }] },
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/anthropic',
      VARIABLE_TIERCE: 'conservée',
    },
  }, null, 2)}\n`);

  const first = bypassClaudeCodeProxy({ userHome });
  const second = bypassClaudeCodeProxy({ userHome });
  const settings = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.VARIABLE_TIERCE, 'conservée');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo tiers');
});

test('le bypass Claude conserve un proxy tiers', (t) => {
  const userHome = temporaryHome(t);
  const directory = path.join(userHome, '.claude');
  fs.mkdirSync(directory, { recursive: true });
  const original = '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example"}}\n';
  fs.writeFileSync(path.join(directory, 'settings.json'), original);

  assert.equal(bypassClaudeCodeProxy({ userHome }).changed, false);
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), original);
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

test('Codex utilise le pass-through ChatGPT avec WebSocket et préserve le TOML', (t) => {
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
  assert.match(content, /supports_websockets = true/);
  assert.match(content, /model = "gpt-test"/);
  assert.match(content, /\[mcp_servers\.tiers\]\ncommand = "serveur-tiers"/);
});

test('Codex reçoit le badge SessionStart sans perdre ses hooks personnels', (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  const hooksFile = path.join(codexHome, 'hooks.json');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(hooksFile, `${JSON.stringify({
    description: 'personnel',
    hooks: {
      SessionStart: [{
        matcher: 'resume',
        hooks: [{ type: 'command', command: 'node personnel.mjs' }],
      }],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.mjs' }] }],
    },
  }, null, 2)}\n`);

  const first = installCodexSessionHook(path.resolve('.'), userHome);
  const second = installCodexSessionHook(path.resolve('.'), userHome);
  const installed = fs.readFileSync(hooksFile, 'utf8');

  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(codexSessionHookStatus(path.resolve('.'), userHome).ok, true);
  assert.match(installed, /PIECEMAKER_HOOK_CLIENT=codex/);
  assert.match(installed, /proxy-guard\.mjs/);
  assert.match(installed, /personnel\.mjs/);
  assert.match(installed, /stop\.mjs/);
});

test('un hooks.json Codex invalide n’est jamais écrasé', (t) => {
  const userHome = temporaryHome(t);
  const hooksFile = path.join(userHome, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, '{ invalide');

  const result = installCodexSessionHook(path.resolve('.'), userHome);

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(hooksFile, 'utf8'), '{ invalide');
});

test('la sentinelle Codex affiche le badge actif seulement si routage et proxy répondent', async (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  const pieceMakerHome = path.join(userHome, '.piecemaker');
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/health/liveliness' ? 200 : 404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  fs.mkdirSync(pieceMakerHome, { recursive: true });
  fs.writeFileSync(path.join(pieceMakerHome, 'config.json'), `${JSON.stringify({ litellmPort: port })}\n`);
  configureCodexProxy({ baseUrl: `http://127.0.0.1:${port}/chatgpt`, codexHome });

  const result = await runHook(
    path.resolve('piecemaker-plugin/scripts/proxy-guard.mjs'),
    { hook_event_name: 'SessionStart', source: 'startup', session_id: 'codex-test' },
    {
      HOME: userHome,
      CODEX_HOME: codexHome,
      PIECEMAKER_HOME: pieceMakerHome,
      PIECEMAKER_HOOK_CLIENT: 'codex',
    },
  );
  const output = JSON.parse(result.stdout);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(output.systemMessage, '🔒 Anonymisation PieceMaker active ✓');
  assert.match(output.hookSpecificOutput.additionalContext, /Codex y est routé/);
});

test('le bypass Codex restaure OpenAI et retire seulement le bloc PieceMaker', (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "gpt-test"',
    '',
    '[mcp_servers.tiers]',
    'command = "serveur-tiers"',
    '',
  ].join('\n'));
  configureCodexProxy({ baseUrl: 'http://127.0.0.1:4000/chatgpt', codexHome });

  const first = bypassCodexProxy({ codexHome });
  const second = bypassCodexProxy({ codexHome });
  const content = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.match(content, /^model_provider = "openai"$/m);
  assert.doesNotMatch(content, /PieceMaker LiteLLM|piecemaker_litellm/);
  assert.match(content, /model = "gpt-test"/);
  assert.match(content, /\[mcp_servers\.tiers\]\ncommand = "serveur-tiers"/);
});

test('le bypass Codex ne normalise pas une configuration tierce', (t) => {
  const userHome = temporaryHome(t);
  const codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const original = 'model_provider = "entreprise"\n\n[model_providers.entreprise]\nbase_url = "https://gateway.example"\n\n';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), original);

  const result = bypassCodexProxy({ codexHome });

  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), original);
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

test('le PID LiteLLM est trouvé sous launchd, où aucun fichier PID n’est écrit', (t) => {
  const userHome = temporaryHome(t);
  const homeDir = path.join(userHome, '.piecemaker');
  fs.mkdirSync(homeDir, { recursive: true });
  // launchd rapporte le processus ; le fichier litellm.pid, lui, n’existe pas.
  const runCapture = () => ({ code: 0, stdout: `\tpid = ${process.pid}\n`, stderr: '' });

  assert.equal(
    litellmProcessPid({ homeDir, repoRoot: userHome, userHome, runCapture }),
    process.pid,
  );
});

test('un fichier PID périmé est nettoyé plutôt que cru sur parole', (t) => {
  const userHome = temporaryHome(t);
  const homeDir = path.join(userHome, '.piecemaker');
  fs.mkdirSync(homeDir, { recursive: true });
  const pidFile = path.join(homeDir, 'litellm.pid');
  // 2^22 dépasse le PID maximal de tout système visé : personne ne tourne là.
  fs.writeFileSync(pidFile, '4194304\n');
  const runCapture = () => ({ code: 1, stdout: '', stderr: 'Could not find service' });

  assert.equal(litellmProcessPid({ homeDir, repoRoot: userHome, userHome, runCapture }), null);
  assert.equal(fs.existsSync(pidFile), false);
});

test('un lancement direct reste détecté quand launchd ne connaît rien', (t) => {
  const userHome = temporaryHome(t);
  const homeDir = path.join(userHome, '.piecemaker');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'litellm.pid'), `${process.pid}\n`);
  const runCapture = () => ({ code: 1, stdout: '', stderr: 'Could not find service' });

  assert.equal(
    litellmProcessPid({ homeDir, repoRoot: userHome, userHome, runCapture }),
    process.pid,
  );
});
