import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, filesOverlap } from './ledger.ts';

const make = () => new Ledger(':memory:');
const base = { repo: '/r/app', why: 'ユーザー「やって」10/27' };

test('a task without a brief waits for one, and a brief makes it ready', () => {
  const ledger = make();
  const task = ledger.add({ ...base, title: 'A' });
  assert.equal(task.status, '依頼文待ち');
  assert.deepEqual(ledger.ready(), []);
  assert.equal(ledger.setBrief(task.id, 'handoff/a.md').status, '待ち');
  assert.deepEqual(ledger.ready().map((t) => t.id), [task.id]);
  assert.deepEqual(ledger.events(task.id).map((e) => e.to_status), ['依頼文待ち', '待ち']);
});

test('ids are per repository and readable', () => {
  const ledger = make();
  assert.equal(ledger.add({ ...base, title: 'A', brief: 'x' }).id, 'app-1');
  assert.equal(ledger.add({ ...base, title: 'B', brief: 'x' }).id, 'app-2');
  assert.equal(ledger.add({ ...base, repo: '/r/random-image-genarator', title: 'C', brief: 'x' }).id, 'random-image-genarator-1');
});

test('after: a task starts only once every earlier task is done', () => {
  const ledger = make();
  const a = ledger.add({ ...base, title: 'A', brief: 'x', files: ['src/a.ts'] });
  const b = ledger.add({ ...base, title: 'B', brief: 'x', files: ['src/b.ts'], after: [a.id] });
  assert.deepEqual(ledger.ready().map((t) => t.id), [a.id]);
  ledger.setStatus(a.id, '走行中');
  assert.deepEqual(ledger.ready(), []);
  ledger.setStatus(a.id, '済');
  assert.deepEqual(ledger.ready().map((t) => t.id), [b.id]);
});

test('after must name tasks that exist', () => {
  assert.throws(() => make().add({ ...base, title: 'B', after: ['nope-1'] }), /after/);
});

test('tasks sharing files do not run together; other repositories are independent', () => {
  const ledger = make();
  const a = ledger.add({ ...base, title: 'A', brief: 'x', files: ['web/app'] });
  const b = ledger.add({ ...base, title: 'B', brief: 'x', files: ['web/app/routes/m/profile.tsx'] });
  const c = ledger.add({ ...base, title: 'C', brief: 'x', files: ['src/db.ts'] });
  const d = ledger.add({ ...base, repo: '/r/other', title: 'D', brief: 'x', files: ['web/app'] });
  assert.deepEqual(ledger.ready().map((t) => t.id), [a.id, c.id, d.id]);
  ledger.setStatus(a.id, '走行中');
  assert.deepEqual(ledger.ready().map((t) => t.id), [c.id, d.id]);
  ledger.setStatus(a.id, '済');
  assert.deepEqual(ledger.ready().map((t) => t.id), [b.id, c.id, d.id]);
});

test('a task with no listed files runs alone in its repository', () => {
  const ledger = make();
  const a = ledger.add({ ...base, title: 'A', brief: 'x' });
  const b = ledger.add({ ...base, title: 'B', brief: 'x', files: ['src/b.ts'] });
  assert.deepEqual(ledger.ready().map((t) => t.id), [a.id]);
  ledger.setStatus(a.id, '済');
  assert.deepEqual(ledger.ready().map((t) => t.id), [b.id]);
});

test('dropping or stalling a task sends what depends on it, transitively, to 判断待ち', () => {
  const ledger = make();
  const a = ledger.add({ ...base, title: 'A', brief: 'x', files: ['a'] });
  const b = ledger.add({ ...base, title: 'B', brief: 'x', files: ['b'], after: [a.id] });
  const c = ledger.add({ ...base, title: 'C', brief: 'x', files: ['c'], after: [b.id] });
  ledger.setStatus(a.id, 'やめ', '要らなくなった');
  assert.equal(ledger.get(b.id)!.status, '判断待ち');
  assert.equal(ledger.get(c.id)!.status, '判断待ち');
  assert.match(ledger.get(b.id)!.note!, /「A」が止まった/);
});

test('holding needs a reason; closed tasks leave the default list', () => {
  const ledger = make();
  const a = ledger.add({ ...base, title: 'A', brief: 'x' });
  assert.throws(() => ledger.setStatus(a.id, '保留'), /理由/);
  ledger.setStatus(a.id, '済');
  assert.deepEqual(ledger.list(), []);
  assert.equal(ledger.list({ all: true }).length, 1);
});

test('filesOverlap compares files and directory prefixes', () => {
  assert.equal(filesOverlap(['web/app'], ['web/app/x.ts']), true);
  assert.equal(filesOverlap(['web/app/'], ['./web/app']), true);
  assert.equal(filesOverlap(['web/app'], ['web/apple.ts']), false);
  assert.equal(filesOverlap([], ['x']), true);
});
