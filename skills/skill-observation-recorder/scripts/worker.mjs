#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.env.CODEX_SKILL_OBSERVATION_DATA_DIR
  ?? join(homedir(), '.codex', 'skill-observations')
const queue = join(root, 'queue')
const lockPath = join(root, 'worker.lock')
const logPath = join(root, 'logs', 'worker.log')

async function log(message) {
  await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 })
  await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })
}

function messageText(payload) {
  if (payload?.type !== 'message' || !Array.isArray(payload.content)) return ''
  return payload.content
    .filter((item) => item && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim()
}

async function conversationFromTranscript(path) {
  const messages = []
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== 'response_item') continue
    const payload = event.payload
    if (payload?.type !== 'message' || !['user', 'assistant'].includes(payload.role)) continue
    const text = messageText(payload)
    if (text) messages.push(`${payload.role.toUpperCase()}: ${text}`)
  }
  const joined = messages.join('\n\n')
  return joined.length <= 120_000 ? joined : joined.slice(-120_000)
}

function extractJsonArray(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : null
  } catch {}
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function analyze(conversation) {
  const prompt = `以下はCodexでの開発会話です。ユーザーがAIの実装・設計・レビュー・調査方法を訂正し、その後に期待する判断が具体化され、修正や実装まで進んで解決した事例だけを抽出してください。

単なる追加要件、仕様変更、タイポ、好みの変更、未解決の議論は除外してください。AIのやり方の失敗として別タスクにも再発しうるものだけ対象にします。

JSON配列のみ返してください。該当なしは []。最大5件。
各要素:
{
  "title": "短い題名",
  "task": "何をしていたか",
  "expected": "ユーザーが期待した判断・やり方",
  "actual": "AIが最初にした望ましくない判断・やり方",
  "why_it_matters": "再発すると何が困るか",
  "resolution": "最終的にどう直したか",
  "severity": "low|medium|high",
  "evidence": "ユーザー訂正を短く要約"
}`

  const command = process.env.SKILL_OBSERVATION_ANALYZER ?? 'claude'
  const model = process.env.SKILL_OBSERVATION_MODEL ?? 'haiku'
  const result = spawnSync(command, [
    '-p', '--model', model,
    '--system-prompt', '会話から再利用可能なAI失敗事例だけを抽出する。JSON以外を出力しない。',
    prompt,
  ], {
    input: conversation,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CLAUDE_HOOK_RUNNING: '1' },
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `analyzer exited ${result.status}`)
  const observations = extractJsonArray(result.stdout.trim())
  if (!observations) throw new Error('analyzer returned invalid JSON')
  return observations
}

async function saveObservations(job, observations) {
  if (observations.length === 0) return null
  const date = (job.ended_at ?? new Date().toISOString()).slice(0, 10)
  const dir = join(root, 'observations', date)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safeId = String(job.session_id).replace(/[^a-zA-Z0-9._-]/g, '_')
  const target = join(dir, `${safeId}.json`)
  await writeFile(target, `${JSON.stringify({
    schema_version: 1,
    session_id: job.session_id,
    cwd: job.cwd,
    ended_at: job.ended_at,
    generated_at: new Date().toISOString(),
    observations,
  }, null, 2)}\n`, { mode: 0o600 })
  return target
}

async function processJob(name) {
  const pending = join(queue, 'pending', name)
  const processing = join(queue, 'processing', name)
  const done = join(queue, 'done', name)
  const failed = join(queue, 'failed', name)
  try {
    await rename(pending, processing)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  try {
    const job = JSON.parse(await readFile(processing, 'utf8'))
    const conversation = await conversationFromTranscript(job.transcript_path)
    if (!conversation) throw new Error('conversation is empty')
    const observations = analyze(conversation)
    const saved = await saveObservations(job, observations)
    await rename(processing, done)
    await log(`${basename(name)}: ${observations.length} observation(s)${saved ? ` -> ${saved}` : ''}`)
  } catch (error) {
    const job = JSON.parse(await readFile(processing, 'utf8').catch(() => '{}'))
    await writeFile(failed, `${JSON.stringify({
      ...job,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { mode: 0o600 })
    await unlink(processing).catch(() => {})
    await log(`${basename(name)}: failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function acquireWorkerLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 10 * 60 * 1000) {
          await unlink(lockPath)
          continue
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError
      }
      return null
    }
  }
  return null
}

await mkdir(join(queue, 'pending'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'processing'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'done'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'failed'), { recursive: true, mode: 0o700 })

const lock = await acquireWorkerLock()
if (!lock) process.exit(0)

try {
  for (const name of (await readdir(join(queue, 'pending'))).filter((name) => name.endsWith('.json')).sort()) {
    await processJob(name)
  }
} finally {
  await lock.close()
  await unlink(lockPath).catch(() => {})
}
