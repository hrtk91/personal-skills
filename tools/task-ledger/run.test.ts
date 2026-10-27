import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.ts';
import { runOnce, type RunDeps } from './run.ts';

function fake(overrides: Partial<RunDeps> = {}) {
  const started: string[] = [];
  const deps: RunDeps = { start: (task, name) => { started.push(`${task.id}:${name}`); return 4242; }, advance: (task) => { started.push(`advance:${task.id}`); }, alive: () => true, load: () => 0.3, ...overrides };
  return { deps, started };
}

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
