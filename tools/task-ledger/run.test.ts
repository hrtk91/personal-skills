import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.ts';
import { runOnce, workerEnv, type RunDeps } from './run.ts';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fake(overrides: Partial<RunDeps> = {}) {
  const started: string[] = [];
  const deps: RunDeps = { start: (task, name) => { started.push(`${task.id}:${name}`); return 4242; }, advance: (task) => { started.push(`advance:${task.id}`); }, alive: () => true, load: () => 0.3, ...overrides };
  return { deps, started };
}

test('task worker/model/effort become the corresponding herdr environment settings', () => {
  const saved = { ...process.env };
  try {
    // Simulate task run being launched from a Pi worker: inherited run settings must not win.
    process.env.IMPL_AGENT = 'pi';
    for (const [worker, model, effort, expected] of [
      ['pi', 'p-model', 'medium', ['pi', 'p-model', 'medium']],
      ['codex', 'c-model', 'high', ['codex', 'c-model', 'high']],
      ['claude', 'haiku', 'high', ['claude', 'haiku', 'high']],
    ] as const) {
      const env = workerEnv({}, { worker, model, effort });
      const modelKey = worker === 'pi' ? 'PI_MODEL' : worker === 'codex' ? 'CODEX_MODEL' : 'CLAUDE_MODEL';
      const effortKey = worker === 'pi' ? 'PI_THINKING' : worker === 'codex' ? 'CODEX_EFFORT' : 'CLAUDE_EFFORT';
      assert.deepEqual([env.IMPL_AGENT, env[modelKey], env[effortKey]], [...expected]);
    }
    assert.equal(workerEnv({}).IMPL_AGENT, 'pi');
    const ledger = new Ledger(':memory:');
    ledger.add({ repo: '/r', title: 'Claude CLI task', why: 'w', brief: 'handoff/claude.md', worker: 'claude', model: 'haiku' });
    let started: NodeJS.ProcessEnv | undefined;
    runOnce(ledger, fake({ start: (task) => { started = workerEnv({ TASK_ID: task.id }, task); return 4242; } }).deps);
    assert.equal(started?.IMPL_AGENT, 'claude');
    assert.equal(started?.CLAUDE_MODEL, 'haiku');
    assert.equal(started?.TASK_ID, 'r-1');
    ledger.close();
  } finally { process.env = saved; }
});

test('a pass starts the oldest ready task once, with its brief name, and records the runner', () => {
  const ledger = new Ledger(':memory:');
  ledger.add({ repo: '/r', title: 'A', why: 'w', brief: 'handoff/fix-a.md', files: ['a.ts'] });
  ledger.add({ repo: '/r', title: 'B', why: 'w', brief: 'handoff/fix-b.md', files: ['b.ts'] });
  const { deps, started } = fake();
  runOnce(ledger, deps);
  assert.deepEqual(started, ['r-1:fix-a']);
  assert.equal(ledger.get('r-1')!.status, '走行中');
  assert.equal(ledger.get('r-1')!.runner, 4242);
  assert.equal(ledger.get('r-1')!.attempts, 1);
  runOnce(ledger, deps);
  assert.deepEqual(started, ['r-1:fix-a', 'r-2:fix-b']);
  runOnce(ledger, deps);
  assert.equal(started.length, 2);
});

test('nothing new starts while the PC is busy', () => {
  const ledger = new Ledger(':memory:');
  ledger.add({ repo: '/r', title: 'A', why: 'w', brief: 'handoff/a.md' });
  const { deps, started } = fake({ load: () => 0.95 });
  assert.match(runOnce(ledger, deps).join('\n'), /忙しい/);
  assert.deepEqual(started, []);
  assert.equal(ledger.get('r-1')!.status, '待ち');
});

test('look-and-feel work is left for Claude, and the next task still starts', () => {
  const ledger = new Ledger(':memory:');
  ledger.add({ repo: '/r', title: '見た目', why: 'w', brief: 'handoff/look.md', kind: '見た目', files: ['web/a.css'] });
  ledger.add({ repo: '/r', title: '処理', why: 'w', brief: 'handoff/logic.md', files: ['src/a.ts'] });
  const { deps, started } = fake();
  assert.match(runOnce(ledger, deps).join('\n'), /r-1: 見た目の仕事なので Claude の番/);
  assert.deepEqual(started, ['r-2:logic']);
  assert.equal(ledger.get('r-1')!.status, '待ち');
});

test('a run whose script vanished goes to 判断待ち, and so do the tasks after it', () => {
  const ledger = new Ledger(':memory:');
  ledger.add({ repo: '/r', title: 'A', why: 'w', brief: 'handoff/a.md' });
  ledger.add({ repo: '/r', title: 'B', why: 'w', brief: 'handoff/b.md', after: ['r-1'] });
  runOnce(ledger, fake().deps);
  const { deps, started } = fake({ alive: () => false });
  runOnce(ledger, deps);
  assert.equal(ledger.get('r-1')!.status, '判断待ち');
  assert.match(ledger.get('r-1')!.note!, /PID 4242/);
  assert.equal(ledger.get('r-2')!.status, '判断待ち');
  assert.deepEqual(started, []);
});

test('a task that cannot be started goes to 判断待ち with the reason', () => {
  const ledger = new Ledger(':memory:');
  ledger.add({ repo: '/r', title: 'A', why: 'w', brief: 'handoff/a.md' });
  runOnce(ledger, fake({ start: () => { throw new Error('ワークスペースが無い'); } }).deps);
  assert.equal(ledger.get('r-1')!.status, '判断待ち');
  assert.match(ledger.get('r-1')!.note!, /ワークスペースが無い/);
});

test('only a previously attempted task with an existing copy gets RESUME=newtab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-ledger-resume-'));
  const ledger = new Ledger(':memory:');
  try {
    const copy = join(dir, 'copy'); mkdirSync(copy);
    ledger.add({ repo: '/r', title: 'old', why: 'w', brief: 'handoff/old.md', files: ['old.ts'] });
    ledger.setStatus('r-1', '走行中', null, { attempts: 1 });
    ledger.setRunner('r-1', { workdir: copy });
    ledger.setStatus('r-1', '判断待ち', 'stopped'); ledger.releaseRunner('r-1');
    ledger.setStatus('r-1', '待ち', '答え: 続ける');
    ledger.add({ repo: '/s', title: 'new', why: 'w', brief: 'handoff/new.md', files: ['new.ts'] });
    const observed: Array<[string, Record<string, string>?]> = [];
    const deps = fake({ start: (task, _name, env) => { observed.push([task.id, env]); return 4242; } }).deps;
    runOnce(ledger, deps);
    runOnce(ledger, deps);
    assert.deepEqual(observed, [['r-1', { RESUME: 'newtab' }], ['s-1', {}]]);
    assert.equal(ledger.get('r-1')!.status, '走行中');
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a run started from inside a resent worker does not inherit its run-only settings', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { RESUME: 'newtab', SKIP_IMPL: '1', HERDR_RUN_SELF: '/x', TASK_ID: 'old-1', PI_MODEL: 'custom' });
    const env = workerEnv({ TASK_ID: 'new-2', REPO: '/r' });
    assert.equal(env.RESUME, undefined);
    assert.equal(env.SKIP_IMPL, undefined);
    assert.equal(env.HERDR_RUN_SELF, undefined);
    assert.equal(env.TASK_ID, 'new-2');
    assert.equal(env.PI_MODEL, 'custom');
    assert.equal(env.HERDR_ENV, '1');
    assert.equal(workerEnv({ RESUME: 'newtab' }).RESUME, 'newtab');
  } finally { process.env = saved; }
});
