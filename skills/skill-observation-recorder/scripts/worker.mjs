#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.env.CODEX_SKILL_OBSERVATION_DATA_DIR
  ?? join(homedir(), '.codex', 'skill-observations')
const queue = join(root, 'queue')
const logPath = join(root, 'logs', 'worker.log')
const MAX_CHUNK_CHARS = 90_000
const CHUNK_OVERLAP_MESSAGES = 6
const configuredAnalyzerTimeout = Number(process.env.SKILL_OBSERVATION_ANALYZER_TIMEOUT_MS ?? 120_000)
const ANALYZER_TIMEOUT_MS = Number.isFinite(configuredAnalyzerTimeout) && configuredAnalyzerTimeout > 0
  ? configuredAnalyzerTimeout
  : 120_000
const CLAIM_LEASE_MS = Math.max(3 * 60 * 1000, ANALYZER_TIMEOUT_MS + 60_000)

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

async function conversationChunksFromTranscript(path, renewClaimLease) {
  const messages = []
  let lastRenewedAt = Date.now()
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    if (Date.now() - lastRenewedAt >= 30_000) {
      await renewClaimLease()
      lastRenewedAt = Date.now()
    }
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== 'response_item') continue
    const payload = event.payload
    if (payload?.type !== 'message' || !['user', 'assistant'].includes(payload.role)) continue
    const text = messageText(payload)
    if (text) messages.push(`${payload.role.toUpperCase()}: ${text}`)
  }

  const chunks = []
  let start = 0
  while (start < messages.length) {
    let end = start
    let chars = 0
    while (end < messages.length) {
      const extra = messages[end].length + (end > start ? 2 : 0)
      if (end > start && chars + extra > MAX_CHUNK_CHARS) break
      chars += extra
      end += 1
      if (chars >= MAX_CHUNK_CHARS) break
    }

    if (end === start) end += 1
    chunks.push(messages.slice(start, end).join('\n\n'))
    if (end >= messages.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP_MESSAGES)
  }
  return chunks
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

const observationFields = ['title', 'task', 'expected', 'actual', 'why_it_matters', 'resolution', 'evidence']

function validateObservations(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('analyzer returned invalid observations')
  for (const observation of value) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new Error('analyzer returned invalid observation')
    }
    if (observationFields.some((field) => typeof observation[field] !== 'string' || !observation[field].trim())) {
      throw new Error('analyzer observation is missing a required string')
    }
    if (!['low', 'medium', 'high'].includes(observation.severity)) {
      throw new Error('analyzer observation has invalid severity')
    }
  }
  return value
}

function runAnalyzer(prompt, input, systemPrompt) {
  const command = process.env.SKILL_OBSERVATION_ANALYZER ?? 'codex'
  const model = process.env.SKILL_OBSERVATION_MODEL
  const instructions = `${systemPrompt}\n\n${prompt}`
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only',
    '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'code_mode_host',
    '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'goals',
    '--disable', 'view_image', '--disable', 'tool_suggest',
  ]
  if (model) args.push('-m', model)
  args.push(instructions)
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    timeout: ANALYZER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SKILL_OBSERVATION_ANALYZER_RUNNING: '1' },
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `analyzer exited ${result.status}`)
  const value = extractJsonArray(result.stdout.trim())
  if (!value) throw new Error('analyzer returned invalid JSON')
  return value
}

function analyze(conversation, chunkIndex, chunkCount) {
  const prompt = `以下はCodexでの開発会話${chunkCount > 1 ? `の一部 (${chunkIndex + 1}/${chunkCount})` : ''}です。ユーザーがAIの実装・設計・レビュー・調査方法を訂正し、その後に期待する判断が具体化され、修正や実装まで進んで解決した事例だけを抽出してください。

単なる追加要件、仕様変更、タイポ、好みの変更、未解決の議論は除外してください。AIのやり方の失敗として別タスクにも再発しうるものだけ対象にします。
${chunkCount > 1 ? 'これは長いsessionを分割したchunkです。このchunk内で訂正と解決の両方を確認できない事例は推測で補わず除外してください。隣接chunkと一部のmessageが重複するため、重複候補は後段で統合されます。' : ''}

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

  return validateObservations(runAnalyzer(
    prompt,
    conversation,
    '会話から再利用可能なAI失敗事例だけを抽出する。JSON以外を出力しない。',
  ), 5)
}

function consolidateObservations(candidates) {
  if (candidates.length <= 1) return candidates

  const prompt = `以下は同一のCodex sessionを複数chunkに分けて抽出したAI失敗候補です。

同じ訂正を指す候補だけを1件へ統合し、別の失敗は分けたまま残してください。候補にない新しい失敗を追加してはいけません。訂正後に解決したことが候補情報から確認できないもの、単なる追加要件・仕様変更・タイポ・好みの変更・未解決議論は除外してください。

JSON配列のみ返してください。最大10件。各要素のschemaは入力と同じにしてください。`

  return validateObservations(runAnalyzer(
    prompt,
    JSON.stringify(candidates),
    '同一sessionのAI失敗候補を重複排除する。入力候補以外を追加せず、JSON以外を出力しない。',
  ), 10)
}

async function saveObservations(job, observations) {
  if (observations.length === 0) return null
  const date = (job.ended_at ?? new Date().toISOString()).slice(0, 10)
  const dir = join(root, 'observations', date)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const storageId = job.storage_id ?? Buffer.from(String(job.session_id)).toString('base64url')
  const jobId = job.job_id ?? randomUUID()
  const target = join(dir, `${storageId}-${jobId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    schema_version: 1,
    job_id: jobId,
    session_id: job.session_id,
    cwd: job.cwd,
    ended_at: job.ended_at,
    generated_at: new Date().toISOString(),
    observations,
  }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  return target
}

async function processJob(name) {
  const pending = join(queue, 'pending', name)
  const processing = join(queue, 'processing', `${name}.${process.pid}.processing`)
  const done = join(queue, 'done', name)
  const failed = join(queue, 'failed', name)
  try {
    const now = new Date()
    await utimes(pending, now, now)
    await rename(pending, processing)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  try {
    const job = JSON.parse(await readFile(processing, 'utf8'))
    const renewClaimLease = () => utimes(processing, new Date(), new Date())
    await renewClaimLease()
    const chunks = await conversationChunksFromTranscript(job.transcript_path, renewClaimLease)
    if (chunks.length === 0) throw new Error('conversation is empty')

    const candidates = []
    for (let index = 0; index < chunks.length; index += 1) {
      await utimes(processing, new Date(), new Date())
      candidates.push(...analyze(chunks[index], index, chunks.length))
    }
    await utimes(processing, new Date(), new Date())
    const observations = consolidateObservations(candidates)
    const saved = await saveObservations(job, observations)
    await rename(processing, done)
    await log(`${basename(name)}: ${chunks.length} chunk(s), ${candidates.length} candidate(s), ${observations.length} observation(s)${saved ? ` -> ${saved}` : ''}`)
  } catch (error) {
    let job = {}
    try { job = JSON.parse(await readFile(processing, 'utf8')) } catch {}
    await writeFile(failed, `${JSON.stringify({
      ...job,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { mode: 0o600 })
    await unlink(processing).catch(() => {})
    await log(`${basename(name)}: failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function claimOwnerPid(name) {
  const match = name.match(/\.json\.(\d+)\.processing$/)
  return match ? Number(match[1]) : null
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function recoverInterruptedJobs() {
  for (const claimName of (await readdir(join(queue, 'processing'))).filter((name) => name.endsWith('.processing')).sort()) {
    const claim = join(queue, 'processing', claimName)
    let claimStat
    try {
      claimStat = await stat(claim)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const leaseIsFresh = Date.now() - claimStat.mtimeMs <= CLAIM_LEASE_MS
    if (processIsAlive(claimOwnerPid(claimName)) && leaseIsFresh) continue
    const marker = claimName.lastIndexOf('.json.')
    if (marker < 0) continue
    const pendingName = claimName.slice(0, marker + 5)
    try {
      await rename(claim, join(queue, 'pending', pendingName))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

await mkdir(join(queue, 'pending'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'processing'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'done'), { recursive: true, mode: 0o700 })
await mkdir(join(queue, 'failed'), { recursive: true, mode: 0o700 })

await recoverInterruptedJobs()
for (const name of (await readdir(join(queue, 'pending'))).filter((name) => name.endsWith('.json')).sort()) {
  await processJob(name)
}
