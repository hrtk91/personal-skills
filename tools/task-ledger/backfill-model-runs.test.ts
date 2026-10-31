import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';

const script = join(import.meta.dirname, 'backfill-model-runs.py');
const line = (value: object) => `${JSON.stringify(value)}\n`;
const session = (cwd: string, timestamp: string, withValues = true) => line({ type: 'session', timestamp, cwd })
  + (withValues ? line({ type: 'model_change', provider: 'openai', modelId: 'gpt-6-luna' }) + line({ type: 'thinking_level_change', thinkingLevel: 'high' }) : '');

test('backfill counts only sessions that join a ledger workdir and carry both values, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  try {
    const db = join(dir, 'ledger.sqlite'); const sessions = join(dir, 'sessions');
    const ledger = new Ledger(db);
    const task = ledger.add({ repo: '/r/x', title: 't', why: 'w', brief: 'b', files: [] });
    ledger.setStatus(task.id, '走行中', null, { agent: 'impl-t', runner: 1 });
    ledger.db.prepare('UPDATE tasks SET workdir=? WHERE id=?').run('/wt/t', task.id);
    ledger.close();
    mkdirSync(join(sessions, 'a'), { recursive: true });
    writeFileSync(join(sessions, 'a', '1.jsonl'), session('/wt/t', '2026-10-30T01:00:00.000Z'));
    writeFileSync(join(sessions, 'a', '2.jsonl'), session('/wt/t', '2026-10-30T02:00:00.000Z'));
    writeFileSync(join(sessions, 'a', 'other-cwd.jsonl'), session('/wt/other', '2026-10-30T01:00:00.000Z'));
    writeFileSync(join(sessions, 'a', 'no-values.jsonl'), session('/wt/t', '2026-10-30T03:00:00.000Z', false));
    const before = [db, join(sessions, 'a', '1.jsonl')].map((path) => readFileSync(path).toString('hex'));
    const count = (...extra: string[]) => JSON.parse(execFileSync('python3', ['-I', script, '--db', db, '--sessions', sessions, ...extra], { encoding: 'utf8' }));
    const all = count();
    assert.equal(all.matchedRuns, 2); assert.equal(all.matchedTasks, 1);
    assert.deepEqual([all.runs[0].provider, all.runs[0].model, all.runs[0].effort, all.runs[0].fast], ['openai', 'gpt-6-luna', 'high', null]);
    assert.equal(count('--before', '2026-10-30T01:30:00Z').matchedRuns, 1);
    assert.deepEqual([db, join(sessions, 'a', '1.jsonl')].map((path) => readFileSync(path).toString('hex')), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
