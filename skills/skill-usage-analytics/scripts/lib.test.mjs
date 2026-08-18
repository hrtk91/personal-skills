import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeTranscriptLines,
  hookCommandFor,
  isSkillUsageHook,
  saveSessionRecord,
} from './lib.mjs'

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload })
}

test('assistant tool calls determine actual activation and user mention determines explicitness', () => {
  const lines = [
    line('2026-08-01T00:00:00Z', 'session_meta', { id: 'transcript-id', cwd: '/repo' }),
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '$review で見て' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    }),
    line('2026-08-01T00:00:02Z', 'response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: "await tools.exec_command({cmd: `sed -n '1,200p' /skills/review/SKILL.md; sed -n '1,200p' /skills/test-design/SKILL.md`})",
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    }),
    line('2026-08-01T00:00:03Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call-1', output: [{ text: '---\nname: review\n---\n---\nname: test-design\n---' }],
    }),
  ]

  const result = analyzeTranscriptLines(lines, { session_id: 'hook-id' })
  assert.equal(result.session_id, 'hook-id')
  assert.equal(result.prompt_count, 1)
  assert.deepEqual(result.turns, [{ turn_id: 'turn-1', prompt: true, skills: [
    { name: 'review', loaded: true, explicitly_requested: true, activation: 'explicit', evidence: 'returned-skill-document' },
    { name: 'test-design', loaded: true, explicitly_requested: false, activation: 'implicit', evidence: 'returned-skill-document' },
  ] }])
})

test('requests and successful reads are classified within the same turn', () => {
  const lines = [
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'message', role: 'user', content: [{ text: '$review first' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    }),
    line('2026-08-01T00:00:02Z', 'response_item', {
      type: 'message', role: 'user', content: [{ text: 'then inspect' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' },
    }),
    line('2026-08-01T00:00:03Z', 'response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'call-2', input: "tools.exec_command({cmd: 'sed /skills/review/SKILL.md'})",
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' },
    }),
    line('2026-08-01T00:00:04Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call-2', output: [{ text: 'name: review\n' }],
    }),
  ]

  const result = analyzeTranscriptLines(lines)
  assert.equal(result.turns[0].skills[0].activation, 'requested-only')
  assert.equal(result.turns[1].skills[0].activation, 'implicit')
})

test('a failed read request is not activation evidence', () => {
  const lines = [
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'call-3', input: "tools.exec_command({cmd: 'sed /skills/review/SKILL.md'})",
    }),
    line('2026-08-01T00:00:02Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call-3', output: [{ text: 'sed: file not found' }],
    }),
  ]

  assert.deepEqual(analyzeTranscriptLines(lines).turns, [])
})

test('numbered SKILL.md output is accepted as successful read evidence', () => {
  const lines = [
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'call-numbered', input: "tools.exec_command({cmd: 'nl -ba /skills/review/SKILL.md'})",
    }),
    line('2026-08-01T00:00:02Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call-numbered', output: [{ text: '     1\t---\n     2\tname: review\n' }],
    }),
  ]

  assert.equal(analyzeTranscriptLines(lines).turns[0].skills[0].activation, 'implicit')
})

test('developer skill catalog and assistant announcements are not activation evidence', () => {
  const lines = [
    line('2026-08-01T00:00:00Z', 'response_item', {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: '/skills/review/SKILL.md' }],
    }),
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '`review` スキルを使います' }],
    }),
    line('2026-08-01T00:00:02Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '$review して' }],
    }),
  ]

  assert.deepEqual(analyzeTranscriptLines(lines).turns[0].skills, [
    { name: 'review', loaded: false, explicitly_requested: true, activation: 'requested-only', evidence: 'explicit-request' },
  ])
})

test('editing or test-fixture text containing SKILL.md paths is not activation evidence', () => {
  const lines = [
    line('2026-08-01T00:00:00Z', 'response_item', {
      type: 'custom_tool_call', name: 'exec', input: "const patch = '/skills/review/SKILL.md'; await tools.apply_patch(patch)",
    }),
    line('2026-08-01T00:00:01Z', 'response_item', {
      type: 'function_call', name: 'apply_patch', arguments: { patch: '/skills/test-design/SKILL.md' },
    }),
  ]

  assert.deepEqual(analyzeTranscriptLines(lines).turns, [])
})

test('malformed transcript lines are ignored', () => {
  const result = analyzeTranscriptLines([
    'not-json',
    '',
    line('2026-08-01T00:00:00Z', 'session_meta', { id: 'ok' }),
    line('2026-08-01T00:00:01Z', 'response_item', { type: 'message', role: 'user', content: [] }),
  ])
  assert.equal(result.session_id, 'ok')
  assert.equal(result.turns.length, 1)
  assert.deepEqual(result.turns[0].skills, [])
  assert.equal(result.parser_status, 'recognized')
})

test('an unknown transcript schema is marked instead of counted as no usage', () => {
  const result = analyzeTranscriptLines([
    'not-json',
    JSON.stringify({ type: 'session_meta', payload: { id: 'future' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'future_payload' } }),
  ])
  assert.equal(result.parser_status, 'unknown-schema')
})

test('session ids cannot escape the records directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'skill-usage-test-'))
  const target = await saveSessionRecord({ session_id: '../../outside' }, dataDir)
  assert.equal(target, join(dataDir, 'sessions', '.._.._outside.json'))
  assert.equal(JSON.parse(await readFile(target, 'utf8')).session_id, '../../outside')
})

test('WindowsのhookはPATHを検索せず実行中のNodeを使う', () => {
  const command = hookCommandFor(
    'C:\\Users\\Example User\\.codex\\skills\\skill-usage-analytics',
    'C:\\Bundled Node\\node.exe',
    'win32',
  )

  assert.equal(command, 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& \'C:\\Bundled Node\\node.exe\' \'C:\\Users\\Example User\\.codex\\skills\\skill-usage-analytics\\scripts\\session-end-hook.mjs\'"')
})

test('POSIXのhookはPATHを検索せず実行中のNodeを使う', () => {
  const command = hookCommandFor('/home/example/.codex/skills/skill-usage-analytics', '/opt/node bin/node', 'linux')

  assert.equal(command, "'/opt/node bin/node' '/home/example/.codex/skills/skill-usage-analytics/scripts/session-end-hook.mjs'")
})

test('POSIXのhookは引用符を含むpathを安全に引用する', () => {
  const command = hookCommandFor(
    "/Users/O'Brien/.codex/skills/skill-usage-analytics",
    "/Applications/O'Brien Node/bin/node",
    'darwin',
  )

  assert.equal(command, "'/Applications/O'\"'\"'Brien Node/bin/node' '/Users/O'\"'\"'Brien/.codex/skills/skill-usage-analytics/scripts/session-end-hook.mjs'")
})

test('既存のskill利用hookはどちらのpath区切りでも検出する', () => {
  assert.equal(isSkillUsageHook("node 'C:\\Users\\me\\.codex\\skills\\skill-usage-analytics\\scripts\\session-end-hook.mjs'"), true)
  assert.equal(isSkillUsageHook("node '/home/me/.codex/skills/skill-usage-analytics/scripts/session-end-hook.mjs'"), true)
  assert.equal(isSkillUsageHook("node '/home/me/.codex/skills/another-skill/scripts/session-end-hook.mjs'"), false)
})
