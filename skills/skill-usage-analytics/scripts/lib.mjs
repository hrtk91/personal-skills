import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { createInterface } from 'node:readline'

const SKILL_PATH_PATTERN = /(?:^|[\\/])([a-z0-9][a-z0-9:-]*(?:-[a-z0-9:-]+)*)[\\/]SKILL\.md\b/gi
const EXPLICIT_SKILL_PATTERN = /(?:^|[\s`(])\$([a-z0-9][a-z0-9:-]*(?:-[a-z0-9:-]+)*)\b/gi

function textFromMessage(payload) {
  if (payload?.type !== 'message' || !Array.isArray(payload.content)) return ''
  return payload.content
    .filter((item) => item && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

function matchedNames(text, pattern) {
  const names = new Set()
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) names.add(match[1].toLowerCase())
  return names
}

function skillReadEvidence(payload) {
  if (payload?.type === 'custom_tool_call') {
    if (payload.name !== 'exec' || typeof payload.input !== 'string') return null
    if (!payload.input.includes('exec_command') || payload.input.includes('tools.apply_patch')) return null
    return payload.input
  }

  if (payload?.type === 'function_call') {
    if (payload.name === 'apply_patch') return null
    return JSON.stringify(payload.arguments ?? payload.input ?? '')
  }

  return null
}

function turnIdFrom(payload, fallback) {
  return payload?.internal_chat_message_metadata_passthrough?.turn_id ?? fallback
}

function returnedSkillDocument(output, skillName) {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)[ \\t]*(?:\\d+[ \\t]+)?name:\\s*["']?${escaped}["']?\\s*(?:\\n|$)`, 'i').test(output)
}

function toolOutputText(payload) {
  if (typeof payload?.output === 'string') return payload.output
  if (Array.isArray(payload?.output)) {
    return payload.output.map((item) => typeof item?.text === 'string' ? item.text : '').join('\n')
  }
  return JSON.stringify(payload?.output ?? '')
}

function createState(hookInput) {
  return {
    hookInput,
    transcriptSessionId: null,
    startedAt: null,
    endedAt: null,
    recognizedPayloads: 0,
    malformedLines: 0,
    promptSequence: 0,
    activeTurnId: null,
    turns: new Map(),
    pendingCalls: new Map(),
  }
}

function getTurn(state, turnId) {
  if (!state.turns.has(turnId)) {
    state.turns.set(turnId, { turn_id: turnId, prompt: false, requested: new Set(), loaded: new Set() })
  }
  return state.turns.get(turnId)
}

function processLine(state, line) {
  if (!line.trim()) return
  let event
  try {
    event = JSON.parse(line)
  } catch {
    state.malformedLines += 1
    return
  }

  state.startedAt ??= event.timestamp ?? null
  state.endedAt = event.timestamp ?? state.endedAt

  if (event.type === 'session_meta') {
    state.transcriptSessionId = event.payload?.id ?? state.transcriptSessionId
    return
  }

  if (event.type !== 'response_item') return
  const payload = event.payload

  if (payload?.type === 'message' && payload.role === 'user') {
    state.recognizedPayloads += 1
    state.promptSequence += 1
    const turnId = turnIdFrom(payload, `prompt-${state.promptSequence}`)
    state.activeTurnId = turnId
    const turn = getTurn(state, turnId)
    turn.prompt = true
    for (const name of matchedNames(textFromMessage(payload), EXPLICIT_SKILL_PATTERN)) turn.requested.add(name)
    return
  }

  const evidence = skillReadEvidence(payload)
  if (evidence) {
    state.recognizedPayloads += 1
    const names = matchedNames(evidence, SKILL_PATH_PATTERN)
    if (names.size > 0 && payload.call_id) {
      state.pendingCalls.set(payload.call_id, {
        turnId: turnIdFrom(payload, state.activeTurnId ?? 'unknown-turn'),
        names,
      })
    }
    return
  }

  if (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') {
    state.recognizedPayloads += 1
    const pending = state.pendingCalls.get(payload.call_id)
    if (!pending) return
    const output = toolOutputText(payload)
    const turn = getTurn(state, pending.turnId)
    for (const name of pending.names) {
      if (returnedSkillDocument(output, name)) turn.loaded.add(name)
    }
    state.pendingCalls.delete(payload.call_id)
  }
}

function finalize(state) {
  const turns = [...state.turns.values()]
    .map((turn) => ({
      turn_id: turn.turn_id,
      prompt: turn.prompt,
      skills: [...new Set([...turn.loaded, ...turn.requested])]
        .sort()
        .map((name) => ({
          name,
          loaded: turn.loaded.has(name),
          explicitly_requested: turn.requested.has(name),
          activation: turn.loaded.has(name)
            ? turn.requested.has(name) ? 'explicit' : 'implicit'
            : 'requested-only',
          evidence: turn.loaded.has(name) ? 'returned-skill-document' : 'explicit-request',
        })),
    }))
    .filter((turn) => turn.prompt || turn.skills.length > 0)

  return {
    schema_version: 1,
    detector_version: 1,
    source: 'codex-main-session-inferred',
    parser_status: state.recognizedPayloads > 0 ? 'recognized' : 'unknown-schema',
    session_id: state.hookInput.session_id ?? state.transcriptSessionId ?? basename(state.hookInput.transcript_path ?? '', '.jsonl'),
    transcript_session_id: state.transcriptSessionId,
    started_at: state.startedAt,
    ended_at: state.endedAt,
    recorded_at: new Date().toISOString(),
    prompt_count: turns.filter((turn) => turn.prompt).length,
    malformed_line_count: state.malformedLines,
    turns,
  }
}

export function analyzeTranscriptLines(lines, hookInput = {}) {
  const state = createState(hookInput)
  for (const line of lines) processLine(state, line)
  return finalize(state)
}

export async function analyzeTranscriptFile(transcriptPath, hookInput = {}) {
  const state = createState({ ...hookInput, transcript_path: transcriptPath })
  const lines = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity })
  for await (const line of lines) processLine(state, line)
  return finalize(state)
}

export async function saveSessionRecord(record, dataDir) {
  const sessionsDir = join(dataDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 })
  await chmod(sessionsDir, 0o700)
  const safeSessionId = String(record.session_id).replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!safeSessionId || safeSessionId === '.' || safeSessionId === '..') throw new Error('invalid session_id')
  const target = join(sessionsDir, `${safeSessionId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  return target
}

export async function readHookInput(stream) {
  let input = ''
  for await (const chunk of stream) input += chunk
  return JSON.parse(input || '{}')
}

export function defaultDataDir(homeDir) {
  return join(homeDir, '.codex', 'skill-usage')
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

export function hookCommandFor(skillDir, nodePath = process.execPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32 : posix
  const scriptPath = pathApi.join(skillDir, 'scripts', 'session-end-hook.mjs')
  if (platform === 'win32') {
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ${quotePowerShellLiteral(nodePath)} ${quotePowerShellLiteral(scriptPath)}"`
  }
  return `${quoteShellArgument(nodePath)} ${quoteShellArgument(scriptPath)}`
}

export function isSkillUsageHook(command) {
  return typeof command === 'string'
    && command.replaceAll('\\', '/').includes('/skill-usage-analytics/scripts/session-end-hook.mjs')
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  let mode = 0o600
  try {
    mode = (await stat(path)).mode & 0o777
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await rename(temporary, path)
}
