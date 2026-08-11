#!/usr/bin/env node
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function acquireLock(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await open(path, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - (await stat(path)).mtimeMs > 10_000) {
          await unlink(path)
          continue
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError
      }
      await delay(50)
    }
  }
  throw new Error(`timed out waiting for installer lock: ${path}`)
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const hooksPath = process.env.CODEX_HOOKS_PATH ?? join(homedir(), '.codex', 'hooks.json')
const skillDir = process.env.CODEX_SKILL_OBSERVATION_DIR
  ?? join(dirname(hooksPath), 'skills', 'skill-observation-recorder')
const lockPath = `${hooksPath}.skill-observation-recorder.lock`
const scriptPath = join(skillDir, 'scripts', 'session-end-hook.mjs')
const command = `node '${scriptPath.replaceAll("'", "'\\\"'\\\"'")}'`

await mkdir(dirname(hooksPath), { recursive: true, mode: 0o700 })
const lock = await acquireLock(lockPath)
try {
  let config = { hooks: {} }
  try {
    await access(hooksPath)
    config = JSON.parse(await readFile(hooksPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  config.hooks ??= {}
  config.hooks.SessionEnd ??= []
  const existing = config.hooks.SessionEnd
    .flatMap((group) => group?.hooks ?? [])
    .find((hook) => hook?.type === 'command'
      && hook.command?.includes('/skill-observation-recorder/scripts/session-end-hook.mjs'))

  if (existing) {
    existing.command = command
    existing.timeout = 3
  } else {
    config.hooks.SessionEnd.push({ hooks: [{ type: 'command', command, timeout: 3 }] })
  }

  await writeJsonAtomic(hooksPath, config)
  console.log(`installed: ${hooksPath}`)
} finally {
  await lock.close()
  await unlink(lockPath).catch(() => {})
}
