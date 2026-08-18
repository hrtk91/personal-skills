#!/usr/bin/env node
import { access, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { hookCommandFor, isSkillUsageHook, writeJsonAtomic } from './lib.mjs'

async function acquireLock(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await open(path, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lockAgeMs = Date.now() - (await stat(path)).mtimeMs
        if (lockAgeMs > 10_000) {
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

const hooksPath = process.env.CODEX_HOOKS_PATH ?? join(homedir(), '.codex', 'hooks.json')
const skillDir = process.env.CODEX_SKILL_USAGE_DIR
  ?? join(dirname(hooksPath), 'skills', 'skill-usage-analytics')
const lockPath = `${hooksPath}.skill-usage-analytics.lock`
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
  const command = hookCommandFor(skillDir)
  let installedHook = null
  for (const group of config.hooks.SessionEnd) {
    installedHook = group?.hooks?.find((hook) => hook?.type === 'command'
      && isSkillUsageHook(hook.command)) ?? installedHook
  }

  if (!installedHook) {
    config.hooks.SessionEnd.push({ hooks: [{ type: 'command', command, timeout: 3 }] })
    await writeJsonAtomic(hooksPath, config)
    console.log(`installed: ${hooksPath}`)
  } else if (installedHook.command !== command || installedHook.timeout !== 3) {
    installedHook.command = command
    installedHook.timeout = 3
    await writeJsonAtomic(hooksPath, config)
    console.log(`updated: ${hooksPath}`)
  } else {
    console.log(`already installed: ${hooksPath}`)
  }
} finally {
  await lock.close()
  await unlink(lockPath).catch(() => {})
}
