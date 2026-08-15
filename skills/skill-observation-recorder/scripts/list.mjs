#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.env.CODEX_SKILL_OBSERVATION_DATA_DIR
  ?? join(homedir(), '.codex', 'skill-observations')
const observationsDir = join(root, 'observations')
const limit = Number(process.argv[2] ?? 20)

const rows = []
for (const date of (await readdir(observationsDir).catch(() => [])).sort().reverse()) {
  const dir = join(observationsDir, date)
  for (const name of (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).sort().reverse()) {
    let record
    try { record = JSON.parse(await readFile(join(dir, name), 'utf8')) } catch { continue }
    for (const item of record.observations ?? []) {
      rows.push({ date, session_id: record.session_id, ...item })
      if (rows.length >= limit) break
    }
    if (rows.length >= limit) break
  }
  if (rows.length >= limit) break
}

if (rows.length === 0) {
  console.log('no observations')
  process.exit(0)
}

for (const row of rows) {
  console.log(`${row.date} [${row.severity ?? 'unknown'}] ${row.title ?? '(untitled)'}`)
  console.log(`  expected: ${row.expected ?? ''}`)
  console.log(`  actual:   ${row.actual ?? ''}`)
  if (row.resolution) console.log(`  resolved: ${row.resolution}`)
  console.log(`  session:  ${row.session_id}`)
}
