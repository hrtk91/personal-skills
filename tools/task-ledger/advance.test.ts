if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { advance, herdrTabSweepCandidates, outsideTaskFiles, parseVerdict, realAdvanceDeps, sweepHerdrTabs, type AdvanceDeps } from './advance.ts';
import { buildTrace, renderTrace } from './trace.ts';
import { taskContext } from './context.ts';
import { main } from './cli.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository, a worker's worktree with one finished commit, and a task waiting at 確かめ中. */
function fixture(options: { check?: string; attempts?: number; files?: string[]; deploy?: boolean } = {}) {
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
  ledger.add({ repo, title: '掛け算を足す', why: 'w', brief: 'handoff/t.md', check: options.check ?? 'test -f mul.js', files: options.files ?? [], deploy: options.deploy });
  ledger.setStatus('repo-1', '走行中', null, { attempts: options.attempts ?? 1 });
  ledger.setRunner('repo-1', { workdir });
  ledger.setStatus('repo-1', '確かめ中', '作業役が終わった');
  return { dir, repo, workdir, ledger, done: () => { rmSync(dir, { recursive: true, force: true }); delete process.env.TASK_LEDGER_DB; } };
}

function deps(answer: string, calls: string[] = [], deployCode = 0): AdvanceDeps {
  return {
    sh: (command, cwd, timeout) => {
      calls.push(command);
      if (command.includes('TASK_ID=')) return { code: deployCode, output: deployCode === 0 ? 'deployed' : 'deploy failed' };
      return command.includes('--cleanup') ? { code: 0, output: '' } : realAdvanceDeps.sh(command, cwd, timeout);
    },
    review: (prompt) => { calls.push(`review:${prompt}`); return answer; },
    resend: (_task, _name, briefRefreshed) => { calls.push('resend'); calls.push(`resend:${briefRefreshed === true}`); return 777; },
    pause: () => {},
  };
}

test('an unmet report without the environment marker is still returned to the worker', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '結論\n\n終わりの条件: 満たしていない — 偽物の claude を起動する；検査を通す\n');
    const calls: string[] = [];
    const said = advance(f.ledger, 'repo-1', deps('', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '走行中');
    assert.equal(task.attempts, 2);
    assert.equal(task.runner, 777);
    assert.ok(calls.includes('resend'));
    assert.ok(!calls.some((call) => call.startsWith('review:')));
    assert.equal(readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8'), '# 掛け算を足す\n');
    assert.match(taskContext(f.ledger, task), /## 今回の差し戻し[\s\S]*偽物の claude を起動する/);
    assert.ok(f.ledger.spans('repo-1').some((span) => span.name === '報告を見る' && span.attributes['report.status'] === '未完了'));
    assert.match(said.join('\n'), /差し戻した/);
  } finally { f.done(); }
});

test('an unmet report marked as environmental immediately waits for a decision without consuming attempts', () => {
  const f = fixture({ attempts: 1 });
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たしていない（環境） — GPU が使用中で学習を開始できない\n');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '判断待ち');
    assert.equal(task.attempts, 1);
    assert.match(task.note!, /^作業役の手で直せない理由で止まった: GPU が使用中で学習を開始できない$/);
    assert.ok(!calls.includes('resend'));
    assert.ok(!calls.some((call) => call.startsWith('review:')));
  } finally { f.done(); }
});

test('sendBack refreshes a stale ordinary brief from committed HEAD and flags the worker prompt', () => {
  const f = fixture({ check: 'echo retry; exit 1' });
  try {
    const newer = '# Updated canonical brief\\n';
    writeFileSync(join(f.repo, 'handoff/t.md'), newer);
    git(f.repo, 'add', 'handoff/t.md'); git(f.repo, 'commit', '-qm', 'update canonical brief');
    const calls: string[] = [];
    const said = advance(f.ledger, 'repo-1', deps('', calls), 1);
    assert.equal(readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8'), newer);
    assert.ok(calls.includes('resend:true'));
    assert.match(said.join('\\n'), /依頼文を本体の版で置き直した（本体 [0-9a-f]+）/);
    assert.match(readFileSync(join(f.dir, 'logs/repo-1.log'), 'utf8'), /依頼文を本体の版で置き直した（本体 [0-9a-f]+）/);
    assert.match(f.ledger.get('repo-1')!.note!, /^差し戻し:/);
  } finally { f.done(); }
});

test('sendBack restores a missing worktree brief from committed HEAD', () => {
  const f = fixture({ check: 'echo retry; exit 1' });
  try {
    const canonical = readFileSync(join(f.repo, 'handoff/t.md'));
    rmSync(join(f.workdir, 'handoff/t.md'));
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    assert.deepEqual(readFileSync(join(f.workdir, 'handoff/t.md')), canonical);
    assert.ok(calls.includes('resend:true'));
  } finally { f.done(); }
});

test('sendBack leaves the worktree brief alone when the canonical committed brief is missing', () => {
  const f = fixture({ check: 'echo retry; exit 1' });
  try {
    const before = readFileSync(join(f.workdir, 'handoff/t.md'));
    git(f.repo, 'rm', '-q', 'handoff/t.md'); git(f.repo, 'commit', '-qm', 'remove canonical brief');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    assert.deepEqual(readFileSync(join(f.workdir, 'handoff/t.md')), before);
    assert.ok(calls.includes('resend:false'));
    if (existsSync(join(f.dir, 'logs/repo-1.log'))) assert.doesNotMatch(readFileSync(join(f.dir, 'logs/repo-1.log'), 'utf8'), /依頼文を本体の版で置き直した/);
  } finally { f.done(); }
});

test('sendBack leaves a matching brief and an Issue brief untouched', () => {
  for (const issueTask of [false, true]) {
    const f = fixture({ check: 'echo retry; exit 1' });
    try {
      let brief = join(f.workdir, 'handoff/t.md');
      if (issueTask) {
        const issue = f.ledger.addIssue({ repo: f.repo, title: 'Issue', body: 'issue body', by: 'Claude' });
        f.ledger.db.prepare('UPDATE tasks SET issue_id=?, brief=? WHERE id=?').run(issue.id, `handoff/${issue.id}.md`, 'repo-1');
        brief = join(f.workdir, `handoff/${issue.id}.md`);
        writeFileSync(brief, '# Generated Issue brief\\n');
      }
      const before = readFileSync(brief);
      const calls: string[] = [];
      advance(f.ledger, 'repo-1', deps('', calls), 1);
      assert.deepEqual(readFileSync(brief), before);
      assert.ok(calls.includes('resend:false'));
      if (existsSync(join(f.dir, 'logs/repo-1.log'))) assert.doesNotMatch(readFileSync(join(f.dir, 'logs/repo-1.log'), 'utf8'), /依頼文を本体の版で置き直した/);
    } finally { f.done(); }
  }
});

test('sendBack preserves ordinary and Issue briefs byte-for-byte and exposes the latest reason and detail in context', () => {
  for (const issueTask of [false, true]) {
    const f = fixture({ check: 'echo detail-line; exit 1' });
    try {
      const brief = join(f.workdir, 'handoff/t.md');
      if (issueTask) {
        const issue = f.ledger.addIssue({ repo: f.repo, title: 'Issue', body: 'issue body', by: 'Claude' });
        const task = f.ledger.get('repo-1')!;
        f.ledger.db.prepare('UPDATE tasks SET issue_id=?, brief=? WHERE id=?').run(issue.id, `handoff/${issue.id}.md`, task.id);
        const issueBrief = join(f.workdir, `handoff/${issue.id}.md`);
        writeFileSync(issueBrief, '# Canonical issue brief\\n');
        const before = readFileSync(issueBrief);
        advance(f.ledger, task.id, deps(''), 1);
        assert.deepEqual(readFileSync(issueBrief), before);
        const context = taskContext(f.ledger, f.ledger.get(task.id)!);
        assert.match(context, /## 今回の差し戻し[\s\S]*確かめのコマンド[\s\S]*detail-line/);
      } else {
        const before = readFileSync(brief);
        advance(f.ledger, 'repo-1', deps(''), 1);
        assert.deepEqual(readFileSync(brief), before);
        const context = taskContext(f.ledger, f.ledger.get('repo-1')!);
        assert.match(context, /## 今回の差し戻し[\s\S]*確かめのコマンド[\s\S]*detail-line/);
      }
    } finally { f.done(); }
  }
});

test('a report that cannot decide why conditions are unmet waits for a decision, without review or resend', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たしていない — 決められない: 外部サービスの権限が必要\n');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(f.ledger.get('repo-1')!.note!, /外部サービスの権限が必要/);
    assert.ok(!calls.includes('resend'));
    assert.ok(!calls.some((call) => call.startsWith('review:')));
  } finally { f.done(); }
});

test('changed paths outside task.files appear in the review request and review span', () => {
  const f = fixture({ files: ['math.js', 'mul.js'] });
  try {
    writeFileSync(join(f.workdir, 'outside.txt'), 'unexpected\n');
    git(f.workdir, 'add', 'outside.txt'); git(f.workdir, 'commit', '-qm', 'outside change');
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\n');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"判断","reasons":[],"fixes":[]}', calls), 1);
    assert.ok(calls.find((call) => call.startsWith('review:'))!.startsWith('review:触るファイルの外の変更: outside.txt（作業役の報告と照らすこと）'));
    const reviewSpan = f.ledger.spans('repo-1').find((span) => span.name === 'レビュー')!;
    assert.equal(reviewSpan.attributes['diff.outside_files'], '["outside.txt"]');
  } finally { f.done(); }
});

test('changes entirely within task.files produce no outside notice or trace attribute', () => {
  const f = fixture({ files: ['mul.js'] });
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\n');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"判断","reasons":[],"fixes":[]}', calls), 1);
    assert.doesNotMatch(calls.find((call) => call.startsWith('review:'))!, /^review:触るファイルの外の変更:/);
    const reviewSpan = f.ledger.spans('repo-1').find((span) => span.name === 'レビュー')!;
    assert.equal(reviewSpan.attributes['diff.outside_files'], undefined);
  } finally { f.done(); }
});

test('brief and harness-generated report/design files do not produce an outside notice', () => {
  const f = fixture({ files: ['mul.js'] });
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\n');
    writeFileSync(join(f.workdir, 'handoff/t-design.md'), '# 設計\n');
    git(f.workdir, 'add', 'handoff/t-report.md', 'handoff/t-design.md');
    git(f.workdir, 'commit', '-qm', 'harness report and design');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"判断","reasons":[],"fixes":[]}', calls), 1);
    assert.doesNotMatch(calls.find((call) => call.startsWith('review:'))!, /^review:触るファイルの外の変更:/);
    const reviewSpan = f.ledger.spans('repo-1').find((span) => span.name === 'レビュー')!;
    assert.equal(reviewSpan.attributes['diff.outside_files'], undefined);
    assert.equal(f.ledger.spans('repo-1').find((span) => span.name === '報告を見る')!.attributes['report.status'], '満たした');
  } finally { f.done(); }
});

test('files allow exact paths and files beneath declared folders only', () => {
  assert.deepEqual(outsideTaskFiles(['src/a.ts', 'skills/herdr/tests/test_x.py', 'other.txt'], ['src/a.ts', 'skills/herdr/tests']), ['other.txt']);
});

test('a report that says conditions are met proceeds to review', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\n');
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('{"verdict":"判断","reasons":[],"fixes":[]}', calls), 1);
    assert.ok(calls.some((call) => call.startsWith('review:')));
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.ok(f.ledger.spans('repo-1').some((span) => span.name === '報告を見る' && span.attributes['report.status'] === '満たした'));
  } finally { f.done(); }
});

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

test('deploy success and failure are delivered to the repository watcher with their outcome', () => {
  const old={channel:process.env.AGENT_CHANNEL,from:process.env.AGENT_CHANNEL_NAME,bin:process.env.TASK_CHANNEL_BIN};
  for(const deployCode of [0,1]){
    const f=fixture({deploy:true});const log=join(f.dir,`deploy-${deployCode}.jsonl`);process.env.AGENT_CHANNEL=log;delete process.env.AGENT_CHANNEL_NAME;process.env.TASK_CHANNEL_BIN=join(import.meta.dirname,'../../skills/herdr/channel/bin/channel');
    try{
      writeFileSync(join(f.workdir,'handoff/t-report.md'),'報告\\n');git(f.workdir,'add','-A');git(f.workdir,'commit','-qm','report');f.ledger.watch(f.repo,'claude-deploy');
      advance(f.ledger,'repo-1',deps('{"verdict":"通す","reasons":[],"fixes":[]}',[],deployCode),1);
      const task=f.ledger.get('repo-1')!;assert.equal(task.status,deployCode===0?'済':'判断待ち');assert.match(task.note??'',deployCode===0?/本番に出した/:/本番に出せなかった/);
      const rows=readFileSync(log,'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));assert.equal(rows.length,1);assert.equal(rows[0].from,'task-ledger');assert.equal(rows[0].to,'claude-deploy');assert.match(rows[0].body,deployCode===0?/済:[\s\S]*本番に出した/:/判断待ち:[\s\S]*本番に出せなかった/);
    }finally{f.done();}
  }
  for(const [key,value] of Object.entries({AGENT_CHANNEL:old.channel,AGENT_CHANNEL_NAME:old.from,TASK_CHANNEL_BIN:old.bin}))if(value===undefined)delete process.env[key];else process.env[key]=value;
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
    assert.equal(readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8'), '# 掛け算を足す\n');
    assert.match(taskContext(f.ledger, task), /## 今回の差し戻し[\s\S]*衝突の印[\s\S]*math\.js/);
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

test('a missing command is an environment failure under Japanese locale: no retry, no attempt consumed, and task trace records it', () => {
  const previousLang = process.env.LANG;
  process.env.LANG = 'ja_JP.UTF-8';
  const f = fixture({ check: 'definitely-not-a-real-check-command' });
  try {
    const calls: string[] = [];
    const said = advance(f.ledger, 'repo-1', deps('', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '判断待ち');
    assert.equal(task.attempts, 1);
    assert.match(task.note!, /環境の失敗/);
    assert.equal(calls.filter((call) => call === 'definitely-not-a-real-check-command').length, 1);
    assert.ok(!calls.includes('resend'));
    const span = f.ledger.spans('repo-1').find((item) => item.name === '確かめ')!;
    assert.equal(span.ok, false);
    assert.equal(span.attributes['step.exit_code'], 127);
    assert.equal(span.attributes['failure.kind'], 'environment');
    const rendered = renderTrace(buildTrace(f.ledger, task)).join('\\n');
    assert.match(rendered, /判断待ち/);
    assert.match(rendered, /確かめ.*failure.kind=environment/);
    assert.match(said.join('\\n'), /環境の失敗/);
  } finally { f.done(); if (previousLang === undefined) delete process.env.LANG; else process.env.LANG = previousLang; }
});

test('a missing script with exit 127 is a worker failure, not an environment failure', () => {
  const f = fixture({ check: 'bash tools/not-yet.sh' });
  try {
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.status, '走行中');
    assert.equal(task.attempts, 2);
    assert.ok(calls.includes('resend'));
    assert.doesNotMatch(task.note ?? '', /環境の失敗/);
    const span = f.ledger.spans('repo-1').find((item) => item.name === '確かめ')!;
    assert.equal(span.attributes['step.exit_code'], 127);
    assert.equal(span.attributes['failure.kind'], undefined);
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
    assert.equal(readFileSync(join(f.workdir, 'handoff/t.md'), 'utf8'), '# 掛け算を足す\n');
    assert.match(taskContext(f.ledger, task), /## 今回の差し戻し[\s\S]*掛け算が無い/);
  } finally { f.done(); }
});

test('a send-back keeps the task list note on one line and Issue recent reasons exclude detail logs', () => {
  const f = fixture({ check: 'cat output.txt; exit 1' });
  try {
    writeFileSync(join(f.workdir, 'output.txt'), 'detail-output\\n');
    const issue = f.ledger.addIssue({ repo: f.repo, title: 'Issue task', body: 'issue body', by: 'Claude' });
    f.ledger.db.prepare('UPDATE tasks SET issue_id=? WHERE id=?').run(issue.id, 'repo-1');
    advance(f.ledger, 'repo-1', deps(''), 1);
    const task = f.ledger.get('repo-1')!;
    assert.equal(task.note?.split('\n').length, 1);
    assert.match(task.note!, /^差し戻し: .*（詳しく: .*sendback/);
    assert.doesNotMatch(task.note!, /detail-output/);
    const context = taskContext(f.ledger, task);
    const recent = context.split('## 直近 7 日の差し戻し理由')[1] ?? '';
    assert.doesNotMatch(recent, /detail-output/);
    const dbPath = join(f.dir, 'cli.sqlite');
    const cliLedger = new Ledger(dbPath);
    const cliTask = cliLedger.add({ repo: f.repo, title: 'single-line', why: 'why', brief: 'handoff/t.md' });
    cliLedger.setStatus(cliTask.id, '走行中', task.note);
    const previousDb = process.env.TASK_LEDGER_DB;
    process.env.TASK_LEDGER_DB = dbPath;
    try {
      const lines: string[] = [];
      main(['list', '--all'], (line) => lines.push(line));
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.split('\n').length, 1);
      assert.match(lines[0]!, /詳しく: .*sendback/);
    } finally {
      if (previousDb === undefined) delete process.env.TASK_LEDGER_DB; else process.env.TASK_LEDGER_DB = previousDb;
      cliLedger.close();
    }
  } finally { f.done(); }
});

test('a send-back context is hidden once the worker has finished', () => {
  const f = fixture({ check: 'echo details; exit 1' });
  try {
    advance(f.ledger, 'repo-1', deps(''), 1);
    const task = f.ledger.get('repo-1')!;
    f.ledger.setStatus(task.id, '確かめ中', '作業役が終わった');
    assert.doesNotMatch(taskContext(f.ledger, f.ledger.get(task.id)!), /## 今回の差し戻し/);
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
    assert.match(saved.history[0]!, /確かめのコマンド/);
    assert.equal(readFileSync(join(f.workdir, brief), 'utf8'), '# Issue task\n');
    assert.match(taskContext(f.ledger, f.ledger.get('repo-1')!), /## 今回の差し戻し[\s\S]*retry/);
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
  const tabs = [{ tab_id: 'tab-done', label: 'done' }, { tab_id: 'not-logged', label: 'other' }, { tab_id: 'tab-user', label: 'user-tab' }];
  const panes = [{ tab_id: 'tab-done', cwd: root }, { tab_id: 'tab-user', cwd: root }];
  try {
    const dry = sweepHerdrTabs(ledger, { roots: [root], tabs, panes, now: finished + 10 * 60_000, dryRun: true, running: () => false });
    assert.match(dry.join('\n'), /tab-done.*10分経過/);
    assert.equal(ledger.spans(task.id).length, 0);
    const closed: string[] = [];
    sweepHerdrTabs(ledger, { roots: [root], tabs, panes, now: finished + 10 * 60_000, close: (id) => closed.push(id), running: () => false });
    assert.deepEqual(closed, ['tab-done']);
    assert.deepEqual(ledger.spans(task.id)[0]!.attributes, { 'cleanup.tab_id': 'tab-done', 'cleanup.reason': 'やめから10分経過' });
    const current = herdrTabSweepCandidates(ledger, { roots: [root], tabs, panes, now: Date.now(), running: () => false });
    assert.ok(!current.some((c) => c.tabId === 'not-logged'));
    assert.ok(!current.some((c) => c.tabId === 'tab-user'), 'an ID match with a different label is not ours');
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
    const found = herdrTabSweepCandidates(ledger, { roots: [], tabs: [{ tab_id: 'external-tab', label: 'orphan' }], panes: [{ tab_id: 'external-tab', cwd }], running: () => false });
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
    const candidates = herdrTabSweepCandidates(ledger, { roots: [root], tabs: [{tab_id:'orphan',label:'orphan'},{tab_id:'decision',label:'decision'},{tab_id:'held',label:'held'}], panes: [{tab_id:'orphan',cwd:'/gone'},{tab_id:'decision',cwd:'/gone'},{tab_id:'held',cwd:'/gone'}], now: Date.now(), running: () => false });
    assert.deepEqual(candidates.map((candidate) => candidate.tabId), ['orphan']);
    assert.match(candidates[0]!.reason, /作業用フォルダが無い/);
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test('review sessions resume only through use four, then start over; cwd changes also start over', () => {
  const f=fixture();
  try {
    writeFileSync(join(f.workdir,'handoff/t-report.md'),'report current');mkdirSync(join(f.dir,'logs'),{recursive:true});writeFileSync(join(f.dir,'logs/repo-1-check-1.log'),'checks passed');
    const calls:{prompt:string;session?:{sessionId?:string;resumePrompt?:string}}[]=[];
    const d=deps('');d.review=(prompt,_cwd,_dirs,session)=>{calls.push({prompt,session});return {answer:'{"verdict":"判断","reasons":["hold"],"fixes":[]}',attributes:{'review.session_id':`sid-${calls.length}`}};};
    for(let i=0;i<5;i++){f.ledger.setStatus('repo-1','レビュー中',`差し戻し: reason-${i}`);advance(f.ledger,'repo-1',d,100+i);}
    assert.equal(calls.length,5);assert.match(calls[0]!.prompt,/## 依頼文/);assert.equal(calls[0]!.session?.sessionId!==undefined,true);assert.equal(calls[0]!.session?.resumePrompt,undefined);
    for(let i=1;i<4;i++){assert.equal(calls[i]!.session?.sessionId,`sid-${i}`);assert.ok(calls[i]!.session?.resumePrompt);assert.match(calls[i]!.prompt,/前回のレビュー以後の変化だけ/);assert.doesNotMatch(calls[i]!.prompt,/## この仕事/);assert.match(calls[i]!.prompt,/\{"verdict"/);assert.ok(calls[i]!.prompt.length<calls[0]!.prompt.length,`resumed prompt ${calls[i]!.prompt.length} >= full ${calls[0]!.prompt.length}`);}
    assert.equal(calls[4]!.session?.resumePrompt,undefined);assert.equal(calls[4]!.session?.sessionId!==`sid-4`,true);assert.equal(f.ledger.claudeSession('repo-1','review')?.uses,1);
    const second=join(f.dir,'wt-second');git(f.repo,'worktree','add','-q','-b','herdr/t-second',second);f.ledger.db.prepare('UPDATE tasks SET workdir=? WHERE id=?').run(second,'repo-1');
    writeFileSync(join(second,'handoff/t-report.md'),'report current');f.ledger.setStatus('repo-1','レビュー中','cwd changed');advance(f.ledger,'repo-1',d,200);
    assert.equal(calls[5]!.session?.resumePrompt,undefined);assert.equal(f.ledger.claudeSession('repo-1','review')?.cwd,second);
  } finally { f.done(); }
});

test('review resume uses the latest sendback event, excludes success note, and includes outsideFiles through real status transitions',()=>{
  const f=fixture();try{
    writeFileSync(join(f.workdir,'handoff/t-report.md'),'current report');mkdirSync(join(f.dir,'logs'),{recursive:true});
    let n=0;const calls:{prompt:string;session?:{sessionId?:string;resumePrompt?:string}}[]=[];const d=deps('');
    d.review=(prompt,_cwd,_dirs,session)=>{calls.push({prompt,session});n++;return {answer:n===1?'{"verdict":"直す","reasons":["fix"],"fixes":["repair"]}':'{"verdict":"判断","reasons":["hold"],"fixes":[]}',attributes:{'review.session_id':`s${n}`}};};
    advance(f.ledger,'repo-1',d,410);assert.equal(f.ledger.get('repo-1')!.status,'走行中');
    f.ledger.setStatus('repo-1','確かめ中','worker returned');f.ledger.releaseRunner('repo-1');
    advance(f.ledger,'repo-1',d,411);
    assert.equal(calls.length,2);assert.match(calls[1]!.prompt,/差し戻しの文: 差し戻し: レビューで直すことになった/);
    assert.doesNotMatch(calls[1]!.prompt,/確かめが通った/);assert.match(calls[1]!.prompt,/対象外ファイルの変更: mul.js/);
    assert.match(calls[1]!.prompt,/前回のレビュー以後の変化だけ/);
  }finally{f.done();}
});

test('failed resume retries once with a fresh session and the full review prompt',()=>{
  const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'report');mkdirSync(join(f.dir,'logs'),{recursive:true});writeFileSync(join(f.dir,'logs/repo-1-check-1.log'),'checks passed');let count=0;const d=deps('');d.review=(prompt,_cwd,_dirs,session)=>{count++;if(count===1)return{answer:'unparseable',attributes:{}};assert.equal(session?.resumePrompt,undefined);assert.notEqual(session?.sessionId,'saved');assert.match(prompt,/## 依頼文/);return{answer:'{"verdict":"判断","reasons":["hold"],"fixes":[]}',attributes:{'review.session_id':'fresh'}};};
    f.ledger.saveClaudeSession('repo-1','review','saved',f.workdir,'HEAD');f.ledger.setStatus('repo-1','レビュー中','retry');advance(f.ledger,'repo-1',d,300);assert.equal(count,2);assert.equal(f.ledger.claudeSession('repo-1','review')?.session_id,'fresh');
  }finally{f.done();}
});

test('a valid resumed verdict that quotes 終了コード 1 is kept without a full re-review',()=>{
  const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'report');mkdirSync(join(f.dir,'logs'),{recursive:true});writeFileSync(join(f.dir,'logs/repo-1-check-1.log'),'checks passed');let count=0;const d=deps('');d.review=(_prompt,_cwd,_dirs,session)=>{count++;assert.ok(session?.resumePrompt);return{answer:'{"verdict":"判断","reasons":["確かめが終了コード 1 で落ちたが原因は環境"],"fixes":[]}',attributes:{'review.session_id':'kept'}};};
    f.ledger.saveClaudeSession('repo-1','review','saved',f.workdir,'HEAD');f.ledger.setStatus('repo-1','レビュー中','retry');advance(f.ledger,'repo-1',d,300);assert.equal(count,1);assert.equal(f.ledger.claudeSession('repo-1','review')?.session_id,'kept');
  }finally{f.done();}
});

test('a resumed review that really exited non-zero (review() mark) is redone in full',()=>{
  const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'report');mkdirSync(join(f.dir,'logs'),{recursive:true});writeFileSync(join(f.dir,'logs/repo-1-check-1.log'),'checks passed');let count=0;const d=deps('');d.review=(_prompt,_cwd,_dirs,session)=>{count++;if(count===1)return{answer:'{"verdict":"通す","reasons":[],"fixes":[]}\n（レビュー役が終了コード 1 で終わった）boom',attributes:{}};assert.equal(session?.resumePrompt,undefined);return{answer:'{"verdict":"判断","reasons":["hold"],"fixes":[]}',attributes:{'review.session_id':'fresh'}};};
    f.ledger.saveClaudeSession('repo-1','review','saved',f.workdir,'HEAD');f.ledger.setStatus('repo-1','レビュー中','retry');advance(f.ledger,'repo-1',d,300);assert.equal(count,2);
  }finally{f.done();}
});

test('real review uses explicit session-id for a new call and resume with a short delta prompt', () => {
  const dir=mkdtempSync(join(tmpdir(),'review-session-cli-')),oldBin=process.env.TASK_CLAUDE_BIN,bin=join(dir,'claude'),argsFile=join(dir,'args'),inputFile=join(dir,'input');
  writeFileSync(bin,`#!/bin/sh\nprintf '%s\\n' "$*" > '${argsFile}'\ncat > '${inputFile}'\nprintf '%s' '{"result":"{\\"verdict\\":\\"通す\\",\\"reasons\\":[],\\"fixes\\":[]}","session_id":"fake-session"}'\n`);chmodSync(bin,0o755);
  try {process.env.TASK_CLAUDE_BIN=bin;const first=realAdvanceDeps.review('whole prompt','/tmp',[dir],{sessionId:'new-id'});assert.match(readFileSync(argsFile,'utf8'),/--session-id new-id/);assert.equal(typeof first,'object');
    const second=realAdvanceDeps.review('only changed prompt','/tmp',[dir],{sessionId:'fake-session',resumePrompt:'only changed prompt'});assert.match(readFileSync(argsFile,'utf8'),/--resume fake-session/);assert.match(readFileSync(inputFile,'utf8'),/^only changed prompt$/);
  } finally {if(oldBin===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldBin;rmSync(dir,{recursive:true,force:true});}
});

test('the verdict is the last valid JSON object in the answer', () => {
  assert.deepEqual(parseVerdict('例: {"verdict":"直す"} …\n結論\n{"verdict":"通す","reasons":["よい"],"fixes":[]}'), { verdict: '通す', reasons: ['よい'], fixes: [] });
  assert.equal(parseVerdict('{"verdict":"たぶん"}'), null);
  assert.equal(parseVerdict('答えなし'), null);
  assert.deepEqual(parseVerdict('```json\n{"verdict":"判断","reasons":["a {b}"]}\n```'), { verdict: '判断', reasons: ['a {b}'], fixes: [] });
});
