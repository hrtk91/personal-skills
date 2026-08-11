#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function readInput() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return JSON.parse(text || '{}')
}

try {
  const input = await readInput()
  if (input.hook_event_name !== 'SessionEnd' || !input.session_id || !input.transcript_path) process.exit(0)

  const root = process.env.CODEX_SKILL_OBSERVATION_DATA_DIR
    ?? join(homedir(), '.codex', 'skill-observations')
  const pendingDir = join(root, 'queue', 'pending')
  await mkdir(pendingDir, { recursive: true, mode: 0o700 })

  const safeId = String(input.session_id).replace(/[^a-zA-Z0-9._-]/g, '_')
  const target = join(pendingDir, `${safeId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  const job = {
    schema_version: 1,
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd ?? null,
    ended_at: new Date().toISOString(),
  }
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)

  const worker = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs')
  const child = spawn(process.execPath, [worker], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CODEX_SKILL_OBSERVATION_DATA_DIR: root },
  })
  child.unref()
} catch (error) {
  process.stderr.write(`[skill-observation-recorder] skipped: ${error instanceof Error ? error.message : String(error)}\n`)
}
