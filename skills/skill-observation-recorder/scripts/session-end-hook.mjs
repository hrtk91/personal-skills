#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const configuredForegroundTimeout = Number(process.env.SKILL_OBSERVATION_FOREGROUND_TIMEOUT_MS ?? 15 * 60 * 1000)
const FOREGROUND_TIMEOUT_MS = Number.isFinite(configuredForegroundTimeout) && configuredForegroundTimeout > 0
  ? configuredForegroundTimeout
  : 15 * 60 * 1000

async function waitForForegroundJob(root, name, deadline, workerError) {
  const done = join(root, 'queue', 'done', name)
  const failed = join(root, 'queue', 'failed', name)
  while (Date.now() < deadline) {
    if (workerError()) throw workerError()
    try {
      const failure = JSON.parse(await readFile(failed, 'utf8'))
      throw new Error(`worker failed: ${failure.error ?? 'unknown error'}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await stat(done)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await sleep(100)
  }
  throw new Error(`worker timed out waiting for ${name}`)
}

async function readInput() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return JSON.parse(text || '{}')
}

function manualInput(args) {
  if (args.length === 0) return null
  const values = new Map()
  let foreground = false
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--foreground') {
      foreground = true
      continue
    }
    if (!['--transcript', '--session-id', '--cwd'].includes(name)) throw new Error(`unknown argument: ${name}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(name === '--transcript' ? '--transcript requires a file path' : `${name} requires a value`)
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`)
    values.set(name, value)
    index += 1
  }
  if (!values.has('--transcript')) throw new Error('--transcript requires a file path')
  return {
    hook_event_name: 'SessionEnd',
    transcript_path: values.get('--transcript'),
    session_id: values.has('--session-id')
      ? values.get('--session-id')
      : `backfill-${Date.now()}`,
    cwd: values.get('--cwd') ?? process.cwd(),
    foreground,
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
  if (manual && input.foreground) {
    const deadline = Date.now() + FOREGROUND_TIMEOUT_MS
    let startError = null
    const child = spawn(process.execPath, [worker], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CODEX_SKILL_OBSERVATION_DATA_DIR: root },
    })
    child.once('error', (error) => { startError = error })
    child.unref()
    await waitForForegroundJob(root, basename(target), deadline, () => startError)
    process.exit(0)
  }
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
