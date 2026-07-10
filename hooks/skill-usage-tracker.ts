#!/usr/bin/env npx ts-node

/**
 * PostToolUse (matcher: Skill) でスキル使用をカウントして蓄積する
 *
 * データ: ~/.claude/sessions/skill-usage.json
 * {
 *   "totals": { "codex": 42, "e2e-testing": 5, ... },
 *   "daily": {
 *     "2026-03-02": { "codex": 3, "e2e-testing": 1 },
 *     ...
 *   },
 *   "last_used": { "codex": "2026-03-02T...", ... }
 * }
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const USAGE_FILE = join(SESSIONS_DIR, 'skill-usage.json')

interface SkillUsageData {
  totals: Record<string, number>
  daily: Record<string, Record<string, number>>
  last_used: Record<string, string>
}

interface HookInput {
  tool_name?: string
  tool_input?: { skill?: string }
}

async function readStdin(): Promise<HookInput> {
  return new Promise((resolve) => {
    let data = ''
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => (data += line))
    rl.on('close', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function loadUsage(): SkillUsageData {
  if (!existsSync(USAGE_FILE)) {
    return { totals: {}, daily: {}, last_used: {} }
  }
  try {
    return JSON.parse(readFileSync(USAGE_FILE, 'utf-8'))
  } catch {
    return { totals: {}, daily: {}, last_used: {} }
  }
}

function saveUsage(data: SkillUsageData): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }
  writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2))
}

async function main() {
  const input = await readStdin()
  const skillName = input.tool_input?.skill
  if (!skillName) return

  const data = loadUsage()
  const today = new Date().toISOString().split('T')[0]
  const now = new Date().toISOString()

  // totals
  data.totals[skillName] = (data.totals[skillName] ?? 0) + 1

  // daily
  if (!data.daily[today]) data.daily[today] = {}
  data.daily[today][skillName] = (data.daily[today][skillName] ?? 0) + 1

  // last_used
  data.last_used[skillName] = now

  // 30日以上前のdailyエントリを削除
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  for (const date of Object.keys(data.daily)) {
    if (date < cutoff) delete data.daily[date]
  }

  saveUsage(data)
  process.exit(0)
}

main()
