#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultDataDir } from './lib.mjs'

const args = process.argv.slice(2)
const daysIndex = args.indexOf('--days')
const days = daysIndex >= 0 ? Number.parseInt(args[daysIndex + 1], 10) : 30
const asJson = args.includes('--json')
if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer')

const dataDir = process.env.CODEX_SKILL_USAGE_DIR ?? defaultDataDir(homedir())
const sessionsDir = join(dataDir, 'sessions')
let files = []
try {
  files = (await readdir(sessionsDir)).filter((file) => file.endsWith('.json'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
const records = []
for (const file of files) {
  try {
    const record = JSON.parse(await readFile(join(sessionsDir, file), 'utf8'))
    if (
      record.schema_version !== 1 ||
      record.parser_status !== 'recognized' ||
      !Number.isInteger(record.prompt_count) ||
      !Array.isArray(record.turns) ||
      record.turns.some((turn) => !turn || !Array.isArray(turn.skills))
    ) continue
    const endedAt = Date.parse(record.ended_at ?? record.recorded_at)
    if (Number.isFinite(endedAt) && endedAt >= cutoff) records.push(record)
  } catch {
    // One damaged record must not hide the rest of the report.
  }
}

const bySkill = new Map()
let activatedSessions = 0
let prompts = 0
for (const record of records) {
  prompts += record.prompt_count ?? 0
  let sessionActivated = false
  const loadedInSession = new Set()
  for (const turn of record.turns) {
    if (!turn || !Array.isArray(turn.skills)) continue
    for (const skill of turn.skills) {
      if (!['explicit', 'implicit', 'requested-only'].includes(skill?.activation) || typeof skill.name !== 'string') continue
      const row = bySkill.get(skill.name) ?? { skill: skill.name, explicit: 0, implicit: 0, requested_only: 0, activations: 0, sessions: 0 }
      row[skill.activation.replace('-', '_')] += 1
      if (skill.loaded) {
        row.activations += 1
        loadedInSession.add(skill.name)
        sessionActivated = true
      }
      bySkill.set(skill.name, row)
    }
  }
  for (const skillName of loadedInSession) bySkill.get(skillName).sessions += 1
  if (sessionActivated) activatedSessions += 1
}

const summary = {
  days,
  sessions: records.length,
  prompts,
  activated_sessions: activatedSessions,
  session_activation_rate: records.length === 0 ? 0 : activatedSessions / records.length,
  skills: [...bySkill.values()]
    .map((row) => ({
      ...row,
      session_activation_rate: records.length === 0 ? 0 : row.sessions / records.length,
    }))
    .sort((a, b) => (b.explicit + b.implicit) - (a.explicit + a.implicit) || a.skill.localeCompare(b.skill)),
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.log(`Codex main-session inferred skill usage: ${days} days`)
console.log(`sessions: ${summary.sessions}, prompts: ${summary.prompts}, activated: ${summary.activated_sessions} (${(summary.session_activation_rate * 100).toFixed(1)}%)`)
console.log('')
console.log('skill                           explicit implicit requested-only activations session-rate')
for (const row of summary.skills) {
  console.log(`${row.skill.padEnd(31)} ${String(row.explicit).padStart(8)} ${String(row.implicit).padStart(8)} ${String(row.requested_only).padStart(14)} ${String(row.activations).padStart(11)} ${(row.session_activation_rate * 100).toFixed(1).padStart(11)}%`)
}
