import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { advance, parseVerdict, realAdvanceDeps, type AdvanceDeps } from './advance.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository, a worker's worktree with one finished commit, and a task waiting at 確かめ中. */
function fixture(options: { check?: string; attempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'task-advance-'));
  process.env.TASK_LEDGER_DB = join(dir, 'ledger.sqlite');
  const repo = join(dir, 'repo'); mkdirSync(join(repo, 'handoff'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'handoff/t.md'), '# 掛け算を足す\n');
  writeFileSync(join(repo, 'math.js'), 'export const sub = (a, b) => a - b;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const workdir = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'herdr/t', workdir);
  writeFileSync(join(workdir, 'mul.js'), 'export const mul = (a, b) => a * b;\n');
  git(workdir, 'add', '-A'); git(workdir, 'commit', '-qm', 'worker');
  const ledger = new Ledger(':memory:');
  ledger.add({ repo, title: '掛け算を足す', why: 'w', brief: 'handoff/t.md', check: options.check ?? 'test -f mul.js' });
  ledger.setStatus('repo-1', '走行中', null, { attempts: options.attempts ?? 1 });
  ledger.setRunner('repo-1', { workdir });
  ledger.setStatus('repo-1', '確かめ中', '作業役が終わった');
  return { dir, repo, workdir, ledger, done: () => { rmSync(dir, { recursive: true, force: true }); delete process.env.TASK_LEDGER_DB; } };
}

function deps(answer: string, calls: string[] = []): AdvanceDeps {
  return {
    sh: (command, cwd, timeout) => {
      calls.push(command);
      return command.includes('--cleanup') ? { code: 0, output: '' } : realAdvanceDeps.sh(command, cwd, timeout);
    },
    review: (prompt) => { calls.push(`review:${prompt}`); return answer; },
    resend: () => { calls.push('resend'); return 777; },
    pause: () => {},
  };
}

test('checked and approved work is merged with the task mark and the worktree is cleaned up', () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('考え…\n{"verdict":"通す","reasons":["依頼どおり"],"fixes":[]}', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '済');
    assert.equal(task.runner, null);
    assert.ok(existsSync(join(f.repo, 'mul.js')));
    assert.match(git(f.repo, 'log', '-1', '--format=%B'), /Task: repo-1/);
    assert.equal(task.commit, git(f.repo, 'rev-parse', 'HEAD').trim());
    const review = calls.find((call) => call.startsWith('review:'))!;
    assert.match(review, /# 掛け算を足す/);
    assert.match(review, /"verdict":"通す\|直す\|判断"/);
    assert.ok(calls.some((call) => call.includes('--cleanup')));
  } finally { f.done(); }
});

test('a failing check goes back to the worker with the output written into its brief', () => {
  const f = fixture({ check: 'echo 掛け算が無い; exit 1' });
  try {
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '走行中');
    assert.equal(task.attempts, 2);
    assert.equal(task.runner, 777);
    assert.ok(calls.includes('resend'));
    assert.ok(!calls.some((call) => call.startsWith('review:')));
    const brief = readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8');
    assert.match(brief, /## 差し戻し（1 回目のあと/);
    assert.match(brief, /掛け算が無い/);
  } finally { f.done(); }
});

test('a review asking for fixes after the last attempt waits for a decision instead', () => {
  const f = fixture({ attempts: 3 });
  try {
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"直す","reasons":["検査が中身を見ていない"],"fixes":["mul を検査する"]}', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '判断待ち');
    assert.match(task.note!, /3 回やって通らなかった/);
    assert.ok(!calls.includes('resend'));
    assert.ok(!existsSync(join(f.repo, 'mul.js')));
  } finally { f.done(); }
});

test('a review asking for a decision stops with its reasons', () => {
  const f = fixture();
  try {
    advance(f.ledger, 'repo-1', deps('{"verdict":"判断","reasons":["依頼文の二つの条件が食い違う"],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(f.ledger.get('repo-1')!.note!, /食い違う/);
  } finally { f.done(); }
});

test('when the check fails after merging, the merge is undone and other uncommitted work is kept', () => {
  // Passes in the worktree, fails in the repository (the marker file exists only in the worktree).
  const f = fixture({ check: 'test -f only-in-worktree' });
  try {
    writeFileSync(join(f.workdir, 'only-in-worktree'), '');
    writeFileSync(join(f.repo, 'notes.txt'), 'まだコミットしていない\n');
    const before = git(f.repo, 'rev-parse', 'HEAD').trim();
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(f.ledger.get('repo-1')!.note!, /戻した/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(readFileSync(join(f.repo, 'notes.txt'), 'utf8'), 'まだコミットしていない\n');
  } finally { f.done(); }
});

test('a task someone else is advancing is left alone', () => {
  const f = fixture();
  try {
    f.ledger.claimRunner('repo-1', ['確かめ中'], 5);
    const said = advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.match(said.join('\n'), /ほかが進めている/);
    assert.equal(f.ledger.get('repo-1')!.status, '確かめ中');
  } finally { f.done(); }
});

test('the verdict is the last valid JSON object in the answer', () => {
  assert.deepEqual(parseVerdict('例: {"verdict":"直す"} …\n結論\n{"verdict":"通す","reasons":["よい"],"fixes":[]}'), { verdict: '通す', reasons: ['よい'], fixes: [] });
  assert.equal(parseVerdict('{"verdict":"たぶん"}'), null);
  assert.equal(parseVerdict('答えなし'), null);
  assert.deepEqual(parseVerdict('```json\n{"verdict":"判断","reasons":["a {b}"]}\n```'), { verdict: '判断', reasons: ['a {b}'], fixes: [] });
});
