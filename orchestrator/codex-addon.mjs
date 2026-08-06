#!/usr/bin/env node

/**
 * Additive Codex session provider for @LordLetinoBot.
 *
 * Claude and Codex are mutually exclusive owners of each project Telegram bot.
 * Claude files are never modified. Codex runtime state lives under ~/.codex.
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Passerelle Codex : chemin propre à chaque poste, déclaré via l'environnement.
// Absente, la garde d'existsSync plus bas fait échouer les verbes Codex avec un
// message clair — le reste du superviseur continue de fonctionner.
const GATEWAY = process.env.PIECEMAKER_CODEX_GATEWAY || ''
const RUNNER = join(HERE, 'codex-session-runner.mjs')
const STATE_ROOT = join(homedir(), '.codex', 'channels')
const CLAUDE_STATE_ROOT = join(homedir(), '.claude', 'channels')
const TURN_TIMEOUT_MS = 12 * 60 * 1000

import { WORKDIRS } from './config.mjs'

export const CODEX_VERBS = new Set([
  '/codex',
  '/start-codex', '/start_codex',
  '/restart-codex', '/restart_codex',
  '/codex-restart', '/codex_restart',
  '/stop-codex', '/stop_codex',
  '/codex-auto', '/codex_auto',
  '/codex-status', '/codex_status',
])

export const CODEX_HELP =
  '\n\n*Sessions Codex (miroir)* :\n' +
  '`/codex` ou `/start-codex` transfère le bot trading de Claude vers Codex\n' +
  '`/restart-codex` ou `/codex-restart` transfère et remet le contexte Codex à zéro\n' +
  '`/stop-codex` arrête la session Codex\n' +
  '`/codex-status` affiche le propriétaire et le mode\n' +
  '`/codex-auto on|off|status` configure le mode autonome supporté\n' +
  'Autre projet : `@app /restart-codex` ou `@dash /codex-status`\n' +
  'Après le transfert, parle normalement au bot Telegram du projet.'

function normalizeVerb(verb) {
  const normalized = String(verb || '').toLowerCase().replaceAll('_', '-')
  return normalized === '/codex-restart' ? '/restart-codex' : normalized
}

export function directCodexCommand(text) {
  const match = String(text || '').trim().match(/^\/(codex|start[-_]codex|restart[-_]codex|codex[-_]restart|stop[-_]codex|codex[-_]auto|codex[-_]status)(?:@\w+)?(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return { verb: normalizeVerb(`/${match[1]}`), arg: (match[2] || '').trim() }
}

export function isSlowCodexVerb(verb) {
  return ['/codex', '/start-codex', '/restart-codex', '/stop-codex'].includes(normalizeVerb(verb))
}

export function codexVerbNeedsClaudeStop(verb) {
  return ['/codex', '/start-codex', '/restart-codex'].includes(normalizeVerb(verb))
}

function stateDirectory(project) {
  const directory = join(STATE_ROOT, `telegram-${project}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function pidPath(project) {
  return join(stateDirectory(project), 'bot.pid')
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function isCodexSessionProcess(pid, project) {
  if (!processAlive(pid)) return false
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString().trim()
    return command.includes('codex-session-runner.mjs') && command.endsWith(` ${project}`)
  } catch {
    return false
  }
}

function codexPid(project) {
  try {
    const pid = Number(readFileSync(pidPath(project), 'utf8').trim())
    return pid && isCodexSessionProcess(pid, project) ? pid : 0
  } catch {
    return 0
  }
}

function launchLabel(project) {
  return `com.tsardet.codex-telegram-${project}`
}

function removeLaunchJob(project) {
  try { execFileSync('launchctl', ['remove', launchLabel(project)], { stdio: 'ignore' }) } catch {}
}

async function waitFor(project, active, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Boolean(codexPid(project)) === active) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  return Boolean(codexPid(project)) === active
}

export async function stopCodexSession(project) {
  const pid = codexPid(project)
  removeLaunchJob(project)
  if (pid && processAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  await waitFor(project, false)
  try { unlinkSync(pidPath(project)) } catch {}
  return Boolean(pid)
}

export async function stopCodexSessions(projects) {
  for (const project of projects) await stopCodexSession(project)
}

async function launchCodexSession(project, restartProcess = false) {
  const workdir = WORKDIRS[project]
  if (!workdir || !existsSync(workdir)) throw new Error(`workspace ${project} introuvable`)
  if (!existsSync(RUNNER) || !existsSync(GATEWAY)) throw new Error('passerelle ou runner Codex introuvable')

  if (codexPid(project) && !restartProcess) return { started: false, pid: codexPid(project) }
  await stopCodexSession(project)

  const directory = stateDirectory(project)
  const log = join(directory, 'daemon.log')
  const node = process.execPath
  execFileSync('launchctl', [
    'submit', '-l', launchLabel(project), '-o', log, '-e', log,
    '--', node, RUNNER, project,
  ])
  execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/${launchLabel(project)}`])
  if (!await waitFor(project, true)) throw new Error('le poller Codex ne démarre pas; voir ' + log)
  return { started: true, pid: codexPid(project) }
}

// Token + chat du projet, lus (en lecture seule) dans l'état Claude qui en est la
// source de vérité. Sans ça, le CLI de la passerelle retombe sur son parseEnvFile()
// par défaut — qui lit le .env d'impt-trader : @app parlerait avec le token de
// @trading. codex-session-runner.mjs résout déjà ses identifiants de cette façon.
function projectCredentials(project) {
  const directory = join(CLAUDE_STATE_ROOT, `telegram-${project}`)
  let token = ''
  let chatId = ''
  try {
    const raw = readFileSync(join(directory, '.env'), 'utf8')
    token = (raw.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1] || '').trim()
  } catch {}
  try {
    const access = JSON.parse(readFileSync(join(directory, 'access.json'), 'utf8'))
    chatId = String(access.allowFrom?.[0] || '')
  } catch {}
  return { token, chatId }
}

function childEnvironment(project) {
  const env = {
    ...process.env,
    PATH: `/Users/tsardet/.nvm/versions/node/v24.11.1/bin:/Users/tsardet/.local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    CODEX_BIN: '/Users/tsardet/.local/bin/codex',
    TELEGRAM_CODEX_ROOT: WORKDIRS[project],
    TELEGRAM_CODEX_STATE: join(stateDirectory(project), 'session-state.json'),
    TELEGRAM_CODEX_SANDBOX: 'read-only',
  }
  for (const name of Object.keys(env)) {
    if (name === 'PRIVATE_KEY' || name === 'COINALYZE_API_KEY' ||
        name === 'NEXT_PUBLIC_RPC_URL' || name.startsWith('TELEGRAM_BOT_')) delete env[name]
  }
  // Après la purge : identifiants explicites du BON projet, pour couper tout
  // repli de la passerelle sur un .env de repo.
  const { token, chatId } = projectCredentials(project)
  if (token) env.TELEGRAM_CODEX_BOT_TOKEN = token
  if (chatId) env.TELEGRAM_CODEX_CHAT_ID = chatId
  return env
}

function runGateway(project, args) {
  const workdir = WORKDIRS[project]
  if (!workdir || !existsSync(workdir)) return Promise.reject(new Error(`workspace ${project} introuvable`))

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [GATEWAY, ...args], {
      cwd: workdir,
      env: childEnvironment(project),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, TURN_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return rejectPromise(new Error('commande Codex expirée'))
      if (code !== 0) return rejectPromise(new Error(stderr.trim().split(/\r?\n/).at(-1) || `sortie ${code}`))
      resolvePromise(stdout.trim())
    })
  })
}

function telegramSafe(text) {
  return String(text || '').replace(/([_*\[\]`])/g, '\\$1')
}

async function applyOne(verb, project, arg) {
  const normalized = normalizeVerb(verb)
  if (normalized === '/codex-status') {
    const details = await runGateway(project, ['--status'])
    return `🤖 @${project} — ${codexPid(project) ? `Codex actif (pid ${codexPid(project)})` : 'Codex arrêté'} · ${details}`
  }
  if (normalized === '/codex-auto') {
    const mode = (arg || 'status').toLowerCase()
    if (!['on', 'off', 'status'].includes(mode)) return `⚠️ @${project} — usage : /codex-auto on|off|status`
    const result = await runGateway(project, ['--auto', mode])
    if (mode !== 'status' && codexPid(project)) await launchCodexSession(project, true)
    return `🤖 @${project} — ${result}${mode === 'on' ? ' · réseau/trading/signatures bloqués' : ''}`
  }
  if (normalized === '/stop-codex') {
    const stopped = await stopCodexSession(project)
    return stopped ? `🛑 @${project} — session Codex arrêtée` : `— @${project} — Codex déjà arrêté`
  }
  if (normalized === '/restart-codex') {
    await runGateway(project, ['--restart-codex'])
    await launchCodexSession(project, true)
    return `♻️ @${project} — token transféré à Codex, contexte neuf. Parle maintenant au bot Telegram ${project}.`
  }
  if (normalized === '/start-codex' || normalized === '/codex') {
    const result = await launchCodexSession(project)
    return `${result.started ? '🚀' : '✓'} @${project} — token ${result.started ? 'transféré à' : 'déjà détenu par'} Codex. Parle maintenant au bot Telegram ${project}.`
  }
  return `⚠️ commande Codex inconnue : ${verb}`
}

export async function applyCodexVerb(verb, projects, arg) {
  const output = []
  for (const project of projects) {
    try {
      output.push(await applyOne(verb, project, arg))
    } catch (error) {
      output.push(`⚠️ @${project} — Codex indisponible : ${telegramSafe(error.message)}`)
    }
  }
  return output.join('\n')
}
