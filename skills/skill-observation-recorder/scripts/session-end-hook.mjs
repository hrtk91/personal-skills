#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

async function readInput() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return JSON.parse(text || '{}')
}

function manualInput(args) {
  if (args.length === 0) return null
  const transcriptIndex = args.indexOf('--transcript')
  const sessionIndex = args.indexOf('--session-id')
  const knownIndexes = new Set([transcriptIndex, transcriptIndex + 1])
  if (sessionIndex >= 0) {
    knownIndexes.add(sessionIndex)
    knownIndexes.add(sessionIndex + 1)
  }
  if (transcriptIndex < 0 || !args[transcriptIndex + 1] || args[transcriptIndex + 1].startsWith('--')) {
    throw new Error('--transcript requires a file path')
  }
  if (sessionIndex >= 0 && (!args[sessionIndex + 1] || args[sessionIndex + 1].startsWith('--'))) {
    throw new Error('--session-id requires a value')
  }
  if (args.some((_, index) => !knownIndexes.has(index))) throw new Error('unknown argument')
  return {
    hook_event_name: 'SessionEnd',
    transcript_path: args[transcriptIndex + 1],
    session_id: sessionIndex >= 0 && args[sessionIndex + 1]
      ? args[sessionIndex + 1]
      : `backfill-${Date.now()}`,
    cwd: process.cwd(),
  }
}

try {
  if (process.env.SKILL_OBSERVATION_ANALYZER_RUNNING === '1') process.exit(0)
  const args = process.argv.slice(2)
  const manual = args.length > 0
  const input = manualInput(args) ?? await readInput()
  if (input.hook_event_name !== 'SessionEnd' || !input.session_id || !input.transcript_path) process.exit(0)
  const transcript = await stat(input.transcript_path)
  if (!transcript.isFile()) throw new Error(`transcript is not a regular file: ${input.transcript_path}`)

  const root = process.env.CODEX_SKILL_OBSERVATION_DATA_DIR
    ?? join(homedir(), '.codex', 'skill-observations')
  const pendingDir = join(root, 'queue', 'pending')
  await mkdir(pendingDir, { recursive: true, mode: 0o700 })

  const storageId = Buffer.from(String(input.session_id)).toString('base64url')
  const jobId = randomUUID()
  const target = join(pendingDir, `${storageId}-${jobId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  const job = {
    schema_version: 1,
    session_id: input.session_id,
    storage_id: storageId,
    job_id: jobId,
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
  if (process.argv.length > 2) process.exitCode = 1
}
