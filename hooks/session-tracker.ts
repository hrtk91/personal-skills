#!/usr/bin/env npx ts-node

/**
 * Claude Code Session Tracker - 稼働中のClaudeセッションを追跡
 *
 * Hooks:
 *   - SessionStart: セッション登録 + 稼働中セッション表示
 *   - UserPromptSubmit: haiku でタスク要約を更新 + 履歴蓄積 (async)
 *   - SessionEnd: セッション終了マーク(retlaude/enqueue.shが履歴を参照した後に削除)
 *
 * データ: ~/.claude/sessions/active.json
 *
 * retlaude/enqueue.sh との連携:
 *   SessionEnd時にtask_historyを残しておき、retlaude/enqueue.shが
 *   Obsidianログに書き込む際の入力として使う。
 *   retlaude/enqueue.shが処理後にセッションを削除する。
 */

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { execSync } from 'child_process'

// === Types ===

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  source?: string // SessionStart: "startup" | "resume" | "clear" | "compact"
}

interface TaskEntry {
  task: string
  at: string
}

interface SessionInfo {
  pid: number
  path: string
  branch: string
  task: string
  task_history: TaskEntry[]
  last_transcript_offset: number // 前回読んだtranscriptの位置(差分取得用)
  started_at: string
  updated_at: string
  ended_at?: string // SessionEnd時にセット
}

interface SessionData {
  sessions: Record<string, SessionInfo>
}

// === Constants ===

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const SESSIONS_FILE = join(SESSIONS_DIR, 'active.json')
const DEBUG_LOG = join(homedir(), '.claude', 'session-tracker-debug.log')

// 2時間更新がない終了済みセッションは削除(retlaude/enqueue.shが取りこぼした場合のガード)
const ENDED_CLEANUP_MS = 2 * 60 * 60 * 1000
// 1時間更新がないアクティブセッションは死んだとみなす
const STALE_THRESHOLD_MS = 60 * 60 * 1000

// === Utilities ===

function debugLog(msg: string): void {
  const time = new Date().toISOString()
  appendFileSync(DEBUG_LOG, `[${time}] ${msg}\n`)
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

function loadSessions(): SessionData {
  if (!existsSync(SESSIONS_FILE)) {
    return { sessions: {} }
  }
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
    // 後方互換
    for (const session of Object.values(data.sessions) as SessionInfo[]) {
      if (!session.task_history) session.task_history = []
      if (session.last_transcript_offset === undefined) session.last_transcript_offset = 0
    }
    return data
  } catch {
    return { sessions: {} }
  }
}

function saveSessions(data: SessionData): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getCurrentBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return '(non-git)'
  }
}

function getProjectName(path: string): string {
  return path.split('/').pop() || 'unknown'
}

/**
 * 死んだセッションをクリーンアップ
 * - ended_at がセットされて2時間経過 → 削除(retlaude/enqueue.shの取りこぼし)
 * - アクティブで1時間更新なし & PID死亡 → 削除
 */
function cleanupDeadSessions(
  data: SessionData,
  excludeId?: string
): number {
  let cleaned = 0
  const now = Date.now()

  for (const [id, session] of Object.entries(data.sessions)) {
    if (id === excludeId) continue

    // 終了済みセッション: 2時間経過で削除
    if (session.ended_at) {
      const endedDuration = now - new Date(session.ended_at).getTime()
      if (endedDuration > ENDED_CLEANUP_MS) {
        debugLog(`cleanup ended: ${id} (ended ${Math.round(endedDuration / 60000)}min ago)`)
        delete data.sessions[id]
        cleaned++
      }
      continue
    }

    // アクティブセッション: PID死亡 or 1時間更新なし
    const staleDuration = now - new Date(session.updated_at).getTime()
    const pidDead = !isProcessAlive(session.pid)
    const isStale = staleDuration > STALE_THRESHOLD_MS

    if (pidDead || isStale) {
      debugLog(
        `cleanup active: ${id} (pid=${session.pid}, alive=${!pidDead}, stale=${isStale})`
      )
      delete data.sessions[id]
      cleaned++
    }
  }
  return cleaned
}

/**
 * Claude Code の PID を取得
 */
function findClaudePid(): number {
  try {
    let pid = process.ppid
    for (let i = 0; i < 10; i++) {
      const cmd = execSync(`ps -o command= -p ${pid} 2>/dev/null`, {
        encoding: 'utf-8',
      }).trim()
      if (cmd.includes('claude')) {
        return pid
      }
      const ppidStr = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, {
        encoding: 'utf-8',
      }).trim()
      pid = parseInt(ppidStr)
      if (isNaN(pid) || pid <= 1) break
    }
  } catch {
    // ignore
  }
  return process.ppid
}

/**
 * haiku でタスクを要約(前回からの差分のみ渡す)
 * @returns { summary, newOffset } 要約と新しいオフセット
 */
function summarizeTask(
  transcriptPath: string,
  lastOffset: number
): { summary: string; newOffset: number } {
  if (!existsSync(transcriptPath)) return { summary: '(不明)', newOffset: lastOffset }

  try {
    const content = readFileSync(transcriptPath, 'utf-8')
    const newOffset = content.length

    // 差分がなければスキップ
    if (newOffset <= lastOffset) {
      return { summary: '(変化なし)', newOffset: lastOffset }
    }

    // 前回からの差分を取得(最大10000文字)
    const diff = content.slice(Math.max(lastOffset, newOffset - 10000))

    const summary = execSync(
      `claude -p --model haiku --system-prompt "前置き・説明・装飾マークダウン禁止。Gitコミットメッセージ形式で1行のみ出力。体言止め推奨。絵文字なし。" "この差分の作業をコミットメッセージ形式で1行で出力してください。"`,
      {
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
        input: diff,
        cwd: join(homedir(), '.claude', '_subsessions'),
        env: { ...process.env, CLAUDE_HOOK_RUNNING: '1' },
      }
    ).trim()

    const cleaned = summary
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const result = cleaned.substring(0, 200) || '(要約失敗)'
    return { summary: result, newOffset }
  } catch (err) {
    debugLog(`summarizeTask error: ${err}`)
    return { summary: '(要約失敗)', newOffset: lastOffset }
  }
}

// === Event Handlers ===

function handleSessionStart(input: HookInput): void {
  const data = loadSessions()

  const sessionId = input.session_id || `unknown-${Date.now()}`
  const cwd = input.cwd || process.cwd()
  const now = new Date().toISOString()
  const claudePid = findClaudePid()

  // resume/compact時は既存セッションを更新
  const existing = data.sessions[sessionId]
  if (existing && (input.source === 'resume' || input.source === 'compact')) {
    existing.pid = claudePid
    existing.updated_at = now
    existing.branch = getCurrentBranch(cwd)
    delete existing.ended_at // 再開したらended_atクリア
    debugLog(`resume: ${sessionId} pid=${claudePid}`)
  } else {
    // 新規登録
    data.sessions[sessionId] = {
      pid: claudePid,
      path: cwd,
      branch: getCurrentBranch(cwd),
      task: '(開始直後)',
      task_history: [],
      last_transcript_offset: 0,
      started_at: now,
      updated_at: now,
    }
    debugLog(`register: ${sessionId} pid=${claudePid} cwd=${cwd}`)
  }

  // 死んだセッションをクリーンアップ
  const cleaned = cleanupDeadSessions(data, sessionId)

  saveSessions(data)

  // 他の稼働中セッションを表示(ended_atが無いもの)
  const otherSessions = Object.entries(data.sessions).filter(
    ([id, s]) => id !== sessionId && !s.ended_at
  )

  if (otherSessions.length > 0) {
    console.log(
      `[Session Tracker] 他に${otherSessions.length}件のClaudeが稼働中:`
    )
    for (const [, session] of otherSessions) {
      const project = getProjectName(session.path)
      console.log(`  - [${project}] ${session.branch}: ${session.task}`)
    }
  }

  if (cleaned > 0) {
    debugLog(`cleaned ${cleaned} dead sessions`)
  }
}

function handleUserPromptSubmit(input: HookInput): void {
  if (!input.session_id || !input.transcript_path) return

  const data = loadSessions()
  const session = data.sessions[input.session_id]
  if (!session) return

  // haiku でタスク要約(前回からの差分のみ)
  const { summary: task, newOffset } = summarizeTask(
    input.transcript_path,
    session.last_transcript_offset
  )
  const now = new Date().toISOString()

  // 変化なし・失敗・不明はスキップ
  if (task === '(変化なし)' || task === '(要約失敗)' || task === '(不明)') {
    session.updated_at = now
    saveSessions(data)
    return
  }

  // 前回と同じタスクなら履歴に追加しない(重複防止)
  const lastTask = session.task_history.length > 0
    ? session.task_history[session.task_history.length - 1].task
    : null

  if (task !== lastTask) {
    session.task_history.push({ task, at: now })
  }

  session.task = task
  session.last_transcript_offset = newOffset
  session.updated_at = now

  // ブランチも更新
  if (input.cwd) {
    session.branch = getCurrentBranch(input.cwd)
  }

  saveSessions(data)
  debugLog(`update: ${input.session_id} task="${task}" offset=${newOffset} history=${session.task_history.length}`)
}

/**
 * SessionEnd: セッションを削除せず ended_at をセット
 * retlaude/enqueue.sh が task_history を読んでObsidianに書き込んだ後に削除する
 */
function handleSessionEnd(input: HookInput): void {
  const data = loadSessions()

  if (input.session_id && data.sessions[input.session_id]) {
    data.sessions[input.session_id].ended_at = new Date().toISOString()
    debugLog(`ended: ${input.session_id} (task_history=${data.sessions[input.session_id].task_history.length})`)
  }

  cleanupDeadSessions(data)
  saveSessions(data)
}

// === Main ===

async function main() {
  if (process.env.CLAUDE_HOOK_RUNNING === '1') {
    return
  }

  const input = await readStdin()
  const event = input.hook_event_name

  debugLog(`event=${event} session=${input.session_id} source=${input.source}`)

  switch (event) {
    case 'SessionStart':
      handleSessionStart(input)
      break
    case 'UserPromptSubmit':
      handleUserPromptSubmit(input)
      break
    case 'SessionEnd':
      handleSessionEnd(input)
      break
    default:
      debugLog(`unknown event: ${event}`)
  }

  process.exit(0)
}

main()
