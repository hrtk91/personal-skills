if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('worker, model and effort are nullable and worker is restricted', () => {
  const ledger = make();
  const legacy = ledger.add({ ...base, title: 'legacy' });
  assert.equal(legacy.worker, null);
  assert.equal(legacy.model, null);
  assert.equal(legacy.effort, null);
  const configured = ledger.add({ ...base, title: 'claude', worker: 'claude', model: 'haiku', effort: 'high' });
  assert.deepEqual([configured.worker, configured.model, configured.effort], ['claude', 'haiku', 'high']);
  assert.throws(() => ledger.add({ ...base, title: 'bad', worker: 'other' as never }), /worker/);
  ledger.close();
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

test('ready respects priority without bypassing dependencies or file locks; only waiting tasks can be reordered', () => {
  const ledger=make();
  const a=ledger.add({...base,title:'A',brief:'x',files:['a']});
  const b=ledger.add({...base,title:'B',brief:'x',files:['b']});
  const c=ledger.add({...base,title:'C',brief:'x',files:['a'],after:[a.id]});
  ledger.setPriority(b.id,'first');
  assert.deepEqual(ledger.ready().map(t=>t.id),[b.id,a.id]);
  ledger.setStatus(a.id,'走行中');
  ledger.setPriority(c.id,'first');
  assert.deepEqual(ledger.ready().map(t=>t.id),[b.id]);
  assert.throws(()=>ledger.setPriority(a.id,'first'),/待ち/);
});

test('new schema initialization is idempotent and preserves existing task rows', () => {
  const dir=mkdtempSync(join(tmpdir(),'ledger-migrate-')),path=join(dir,'db.sqlite');
  try {
    const old=new DatabaseSync(path);
    old.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,repo TEXT NOT NULL,title TEXT NOT NULL,why TEXT NOT NULL,brief TEXT,"check" TEXT,after_json TEXT NOT NULL DEFAULT '[]',files_json TEXT NOT NULL DEFAULT '[]',kind TEXT NOT NULL DEFAULT '処理',deploy INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,note TEXT,attempts INTEGER NOT NULL DEFAULT 0,agent TEXT,"commit" TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
      INSERT INTO tasks(id,repo,title,why,status,created_at,updated_at) VALUES('app-1','/r/app','legacy','why','済','2026-01-01','2026-01-01');`); old.close();
    const first=new Ledger(path);assert.equal(first.get('app-1')?.title,'legacy');assert.equal(first.get('app-1')?.worker,null);first.close();
    const second=new Ledger(path);assert.equal(second.get('app-1')?.title,'legacy');assert.equal(second.get('app-1')?.model,null);assert.deepEqual(second.listGoals(),[]);second.close();
  }
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('filesOverlap compares files and directory prefixes', () => {
  assert.equal(filesOverlap(['web/app'], ['web/app/x.ts']), true);
  assert.equal(filesOverlap(['web/app/'], ['./web/app']), true);
  assert.equal(filesOverlap(['web/app'], ['web/apple.ts']), false);
  assert.equal(filesOverlap([], ['x']), true);
});

test('moving to first inserts at the top and keeps the others in order (not a swap with the old top)', () => {
  const ledger=make();
  const [a,b,c,d]=['A','B','C','D'].map((title,n)=>ledger.add({...base,title,brief:'x',files:[`f${n}`]}));
  ledger.setPriority(d!.id,'first');
  assert.deepEqual(ledger.ready().map(t=>t.title),['D','A','B','C']);
  ledger.setPriority(b!.id,'down');
  assert.deepEqual(ledger.ready().map(t=>t.title),['D','A','C','B']);
  const goals=['G1','G2','G3','G4'].map((title)=>ledger.addGoal({repo:base.repo,title}));
  ledger.moveGoal(goals[3]!.id,'first');
  assert.deepEqual(ledger.listGoals(base.repo).map(g=>g.title),['G4','G1','G2','G3']);
  void a; void c;
});
