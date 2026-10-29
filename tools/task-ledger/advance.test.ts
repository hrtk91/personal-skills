import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { advance, herdrTabSweepCandidates, parseVerdict, realAdvanceDeps, sweepHerdrTabs, type AdvanceDeps } from './advance.ts';

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

test('an uncommitted copy of a file the branch adds is moved aside so the merge can go in', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '報告\n');
    git(f.workdir, 'add', '-A'); git(f.workdir, 'commit', '-qm', 'report');
    writeFileSync(join(f.repo, 'handoff/t-report.md'), '本体の古い写し\n');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '済');
    assert.equal(readFileSync(join(f.repo, 'handoff/t-report.md'), 'utf8'), '報告\n');
    assert.equal(readFileSync(join(f.dir, 'logs/repo-1-untracked/handoff/t-report.md'), 'utf8'), '本体の古い写し\n');
  } finally { f.done(); }
});

test('when the repository changed the same lines meanwhile, the worker gets the conflict marks to settle', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'math.js'), 'export const sub = (a, b) => a - b; // 作業役\n');
    git(f.workdir, 'add', '-A'); git(f.workdir, 'commit', '-qm', 'worker edits math');
    writeFileSync(join(f.repo, 'math.js'), 'export const sub = (a, b) => a - b; // 本体\n');
    git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'repo edits math');
    const before = git(f.repo, 'rev-parse', 'HEAD').trim();
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '走行中');
    assert.ok(calls.includes('resend'));
    assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), before);
    assert.match(readFileSync(join(f.workdir, 'math.js'), 'utf8'), /<<<<<<<[\s\S]*作業役[\s\S]*本体/);
    assert.match(readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8'), /衝突の印[\s\S]*math\.js/);
  } finally { f.done(); }
});

test('a check that fails once and passes when run again moves on, keeping the first output', () => {
  const marks = mkdtempSync(join(tmpdir(), 'task-flake-'));
  const f = fixture({ check: `n=$(ls ${marks} | wc -l); touch ${marks}/run-$n; [ $n -ne 0 ] && [ $n -ne 2 ] || { echo 揺れた; exit 1; }` });
  try {
    const said = advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '済');
    assert.equal(said.filter((line) => /1 回目に落ち、流し直して通った/.test(line)).length, 2);
    assert.match(readFileSync(join(f.dir, 'logs/repo-1-check-1-first-fail.log'), 'utf8'), /揺れた/);
  } finally { f.done(); rmSync(marks, { recursive: true, force: true }); }
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

test('an Issue-originated send-back is saved on the Issue and included in the next brief', () => {
  const f = fixture({ check: 'echo retry; exit 1' });
  try {
    const issue = f.ledger.addIssue({ repo: f.repo, title: 'Issue task', fields: {
      'なぜ': 'reason', '今の状態': 'known', '関係する所': 'math.js',
    } });
    const brief = `handoff/${issue.id}.md`;
    writeFileSync(join(f.workdir, brief), '# Issue task\n');
    f.ledger.db.prepare('UPDATE tasks SET issue_id=?, brief=? WHERE id=?').run(issue.id, brief, 'repo-1');
    advance(f.ledger, 'repo-1', deps(''), 1);
    const saved = f.ledger.getIssue(issue.id)!;
    assert.equal(saved.history.length, 1);
    assert.match(saved.history[0]!, /差し戻し（1 回目のあと/);
    assert.match(readFileSync(join(f.workdir, brief), 'utf8'), /## 差し戻し（1 回目のあと/);
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

test('the check after merging runs in a throwaway copy, never in the repository folder', () => {
  const f = fixture({ check: 'test -f mul.js && touch built-here' });
  try {
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '済');
    assert.ok(!existsSync(join(f.repo, 'built-here')));
    assert.equal(git(f.repo, 'worktree', 'list').trim().split('\n').length, 2);
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

test('when someone commits while the check after merging runs, a failed check reverts the merge and keeps their commit', () => {
  const f = fixture({ check: 'test -f only-in-worktree || { git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." -c user.name=t -c user.email=t@t commit -q --allow-empty -m "someone else"; exit 1; }' });
  try {
    writeFileSync(join(f.workdir, 'only-in-worktree'), '');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(git(f.repo, 'log', '--format=%s').trim(), /someone else/);
    assert.ok(!existsSync(join(f.repo, 'mul.js')), 'the merged work is undone');
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

test('tab sweeper only selects logged tabs by completion age and records cleanup span; dry-run does not close', () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-sweep-'));
  const ledger = new Ledger(':memory:');
  const at = new Date('2025-01-01T00:00:00Z');
  const task = ledger.add({ repo: '/repo', title: 'done', why: 'w', brief: 'handoff/done.md' });
  ledger.setStatus(task.id, 'やめ');
  const log = join(root, 'herdr-done.log');
  writeFileSync(log, 'タブ: tab-done（実装 pane・レビュー pane）\n');
  const finished = Date.parse(ledger.events(task.id).at(-1)!.at);
  const tabs = [{ tab_id: 'tab-done' }, { tab_id: 'not-logged' }];
  const panes = [{ tab_id: 'tab-done', cwd: root }];
  try {
    const dry = sweepHerdrTabs(ledger, { roots: [root], tabs, panes, now: finished + 10 * 60_000, dryRun: true, running: () => false });
    assert.match(dry.join('\n'), /tab-done.*10分経過/);
    assert.equal(ledger.spans(task.id).length, 0);
    const closed: string[] = [];
    sweepHerdrTabs(ledger, { roots: [root], tabs, panes, now: finished + 10 * 60_000, close: (id) => closed.push(id), running: () => false });
    assert.deepEqual(closed, ['tab-done']);
    assert.deepEqual(ledger.spans(task.id)[0]!.attributes, { 'cleanup.tab_id': 'tab-done', 'cleanup.reason': 'やめから10分経過' });
    assert.ok(!herdrTabSweepCandidates(ledger, { roots: [root], tabs, panes, now: Date.now(), running: () => false }).some((c) => c.tabId === 'not-logged'));
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test('finds logs outside HERDR_WORK from the pane worktree root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-external-'));
  const work = join(dir, 'custom-work');
  const cwd = join(work, 'wt', 'orphan');
  mkdirSync(cwd, { recursive: true });
  const ledger = new Ledger(':memory:');
  const log = join(work, 'herdr-orphan.log');
  writeFileSync(log, 'タブ: external-tab（実装 pane）\n');
  const ago = new Date(Date.now() - 7 * 60 * 60_000); utimesSync(log, ago, ago);
  try {
    const found = herdrTabSweepCandidates(ledger, { roots: [], tabs: [{ tab_id: 'external-tab' }], panes: [{ tab_id: 'external-tab', cwd }], running: () => false });
    assert.deepEqual(found.map((candidate) => candidate.tabId), ['external-tab']);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('judgment and held tasks are never swept; missing cwd and six-hour orphan log qualify', () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-sweep-'));
  const ledger = new Ledger(':memory:');
  const task = ledger.add({ repo: '/repo', title: 'waiting decision', why: 'w', brief: 'handoff/decision.md' });
  ledger.setStatus(task.id, '判断待ち', 'needs review');
  const held = ledger.add({ repo: '/repo', title: 'held', why: 'w', brief: 'handoff/held.md' });
  ledger.setStatus(held.id, '保留', 'hold');
  const old = join(root, 'herdr-orphan.log'); writeFileSync(old, 'タブ: orphan（実装 pane）\n');
  const decision = join(root, 'herdr-decision.log'); writeFileSync(decision, 'タブ: decision（実装 pane）\n');
  const holdLog = join(root, 'herdr-held.log'); writeFileSync(holdLog, 'タブ: held（実装 pane）\n');
  const ago = new Date(Date.now() - 7 * 60 * 60_000); utimesSync(old, ago, ago);
  try {
    const candidates = herdrTabSweepCandidates(ledger, { roots: [root], tabs: [{tab_id:'orphan'},{tab_id:'decision'},{tab_id:'held'}], panes: [{tab_id:'orphan',cwd:'/gone'},{tab_id:'decision',cwd:'/gone'},{tab_id:'held',cwd:'/gone'}], now: Date.now(), running: () => false });
    assert.deepEqual(candidates.map((candidate) => candidate.tabId), ['orphan']);
    assert.match(candidates[0]!.reason, /作業用フォルダが無い/);
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the verdict is the last valid JSON object in the answer', () => {
  assert.deepEqual(parseVerdict('例: {"verdict":"直す"} …\n結論\n{"verdict":"通す","reasons":["よい"],"fixes":[]}'), { verdict: '通す', reasons: ['よい'], fixes: [] });
  assert.equal(parseVerdict('{"verdict":"たぶん"}'), null);
  assert.equal(parseVerdict('答えなし'), null);
  assert.deepEqual(parseVerdict('```json\n{"verdict":"判断","reasons":["a {b}"]}\n```'), { verdict: '判断', reasons: ['a {b}'], fixes: [] });
});
