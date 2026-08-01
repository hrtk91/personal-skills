#!/usr/bin/env node
import { homedir } from 'node:os'
import { analyzeTranscriptFile, defaultDataDir, readHookInput, saveSessionRecord } from './lib.mjs'

try {
  const input = await readHookInput(process.stdin)
  if (input.hook_event_name !== 'SessionEnd' || !input.transcript_path || !input.session_id) process.exit(0)
  const record = await analyzeTranscriptFile(input.transcript_path, input)
  await saveSessionRecord(record, process.env.CODEX_SKILL_USAGE_DIR ?? defaultDataDir(homedir()))
} catch (error) {
  // SessionEnd analytics must never make ending the Codex session fail.
  process.stderr.write(`[skill-usage-analytics] skipped: ${error instanceof Error ? error.message : String(error)}\n`)
}
