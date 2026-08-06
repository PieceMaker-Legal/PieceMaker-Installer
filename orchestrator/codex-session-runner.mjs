#!/usr/bin/env node

/**
 * Runs one mirrored Telegram/Codex project session.
 *
 * Claude's channel files are read-only inputs for token + allowlist. All Codex
 * runtime state is written below ~/.codex/channels, never into Claude's state.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, runBridge } from 'file:///Users/tsardet/Sites/impt-trader/bot/telegram-codex.mjs'

const PROJECTS = {
  trading: '/Users/tsardet/Sites/impt-trader',
  app: '/Users/tsardet/Sites/GITHUB - Letino Festival/App',
  dashboard: '/Users/tsardet/Sites/GITHUB - Letino Festival/Dashboard',
  website: '/Users/tsardet/Sites/GITHUB - Letino Festival/Website',
}

const project = String(process.argv[2] || '').toLowerCase()
const root = PROJECTS[project]
if (!root || !existsSync(root)) throw new Error(`Unknown or missing project: ${project}`)

const claudeState = join(homedir(), '.claude', 'channels', `telegram-${project}`)
const codexState = join(homedir(), '.codex', 'channels', `telegram-${project}`)
mkdirSync(codexState, { recursive: true, mode: 0o700 })

function envFile(path) {
  const values = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

function processAlive(pidPath) {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim())
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Mutual exclusion is checked again here even though Lord performs the switch.
if (processAlive(join(claudeState, 'bot.pid'))) {
  throw new Error(`Claude ${project} session still owns this Telegram token`)
}

const token = envFile(join(claudeState, '.env')).TELEGRAM_BOT_TOKEN
const access = JSON.parse(readFileSync(join(claudeState, 'access.json'), 'utf8'))
const chatId = String(access.allowFrom?.[0] || '')
if (!token || !chatId) throw new Error(`Telegram token or allowlist missing for ${project}`)

const pidPath = join(codexState, 'bot.pid')
writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 })

const runtimePath = [
  '/Users/tsardet/.nvm/versions/node/v24.11.1/bin',
  '/Users/tsardet/.local/bin',
  process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
].join(':')

const config = loadConfig({
  ...process.env,
  PATH: runtimePath,
  CODEX_BIN: '/Users/tsardet/.local/bin/codex',
  TELEGRAM_CODEX_BOT_TOKEN: token,
  TELEGRAM_CODEX_CHAT_ID: chatId,
  TELEGRAM_CODEX_TRIGGER: '*',
  TELEGRAM_CODEX_SANDBOX: 'read-only',
  TELEGRAM_CODEX_ROOT: root,
  TELEGRAM_CODEX_STATE: join(codexState, 'session-state.json'),
}, {})

try {
  await runBridge(config)
} finally {
  try { unlinkSync(pidPath) } catch {}
}
