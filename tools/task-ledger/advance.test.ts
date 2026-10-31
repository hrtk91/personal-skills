if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { advance, herdrTabSweepCandidates, outsideTaskFiles, parseVerdict, realAdvanceDeps, reapplyRevertedMerge, sendBackEnv, sweepHerdrTabs, type AdvanceDeps } from './advance.ts';
import { buildTrace, renderTrace } from './trace.ts';
import { taskContext } from './context.ts';
import { main } from './cli.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository, a worker's worktree with one finished commit, and a task waiting at 確かめ中. */
function fixture(options: { check?: string; attempts?: number; files?: string[]; deploy?: boolean; worker?: 'pi' | 'codex' | 'claude'; model?: string; effort?: string } = {}) {
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
  ledger.add({ repo, title: '掛け算を足す', why: 'w', brief: 'handoff/t.md', check: options.check ?? 'test -f mul.js', files: options.files ?? [], deploy: options.deploy, worker: options.worker, model: options.model, effort: options.effort });
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

test('a requeued task gets its ledger worker, model and effort in the second-run environment', () => {
  const f = fixture({ worker: 'claude', model: 'sonnet', effort: 'high' });
  try {
    const task = f.ledger.get('repo-1')!;
    const env = sendBackEnv(task, false);
    assert.deepEqual([env.IMPL_AGENT, env.CLAUDE_MODEL, env.CLAUDE_EFFORT], ['claude', 'sonnet', 'high']);
    assert.equal(env.RESUME, 'newtab');
    assert.equal(env.SEND_BACK, '1');
  } finally { f.done(); }
});

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

test('major findings are sent back once, then only the original findings are checked and new findings do not block', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\\n');
    const calls: string[] = [];
    const reviewAnswers = [
      JSON.stringify({ verdict: '通す', reasons: [], fixes: [], findings: [
        { text: '大指摘A', likelihood: 'いつも', harm: '大', blocking: true },
        { text: '大指摘A2', likelihood: 'いつも', harm: '大', blocking: true },
        { text: '中指摘B', likelihood: 'いつも', harm: '中', blocking: false },
      ] }),
      JSON.stringify({ fixed: [1, 2], unfixed: [], new: ['新しい指摘C'] }),
    ];
    const d = deps('', calls);
    d.review = (prompt) => { calls.push(`review:${prompt}`); return reviewAnswers.shift()!; };
    advance(f.ledger, 'repo-1', d, 1);
    assert.equal(f.ledger.get('repo-1')!.status, '走行中');
    assert.equal(f.ledger.claudeSession('repo-1', 'review')?.uses, 1);
    assert.match(readFileSync(join(f.dir, 'logs/repo-1-sendback-1.log'), 'utf8'), /大指摘A/);
    assert.doesNotMatch(readFileSync(join(f.dir, 'logs/repo-1-sendback-1.log'), 'utf8'), /中指摘B/);
    f.ledger.setStatus('repo-1', '確かめ中', 'worker fixed');
    f.ledger.releaseRunner('repo-1');
    advance(f.ledger, 'repo-1', d, 1);
    const reviewCalls = calls.filter((call) => call.startsWith('review:'));
    assert.equal(reviewCalls.length, 2);
    assert.match(reviewCalls[1]!, /1\. 大指摘A/);
    assert.match(reviewCalls[1]!, /2\. 大指摘A2/);
    assert.doesNotMatch(reviewCalls[1]!, /中指摘B/);
    assert.match(reviewCalls[1]!, /"fixed":\[1,3\]/);
    assert.equal(f.ledger.get('repo-1')!.status, '済');
    assert.match(f.ledger.get('repo-1')!.note!, /新しい指摘C/);
    assert.equal(reviewAnswers.length, 0);
  } finally { f.done(); }
});

test('a second review with any unresolved original major finding waits and cannot trigger a third review', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\\n');
    const calls: string[] = [];
    const answers = [
      JSON.stringify({ verdict: '通す', reasons: [], fixes: [], findings: [{ text: '重大X', likelihood: 'いつも', harm: '大', blocking: true }] }),
      JSON.stringify({ fixed: [], unfixed: [1], new: [] }),
    ];
    const d = deps('', calls);
    d.review = (prompt) => { calls.push(`review:${prompt}`); return answers.shift()!; };
    advance(f.ledger, 'repo-1', d, 1);
    f.ledger.setStatus('repo-1', '確かめ中', 'worker returned');
    f.ledger.releaseRunner('repo-1');
    advance(f.ledger, 'repo-1', d, 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(f.ledger.get('repo-1')!.note!, /直っていない指摘: 重大X/);
    assert.equal(calls.filter((call) => call.startsWith('review:')).length, 2);
    assert.equal(answers.length, 0);
  } finally { f.done(); }
});

test('a second review with a missing or unknown number is unreadable and waits', () => {
  for (const response of ['{"fixed":[],"unfixed":[],"new":[]}', '{"fixed":[2],"unfixed":[],"new":[]}']) {
    const f = fixture();
    try {
      writeFileSync(join(f.workdir, 'handoff/t-report.md'), '終わりの条件: 満たした\\n');
      const answers = [
        JSON.stringify({ verdict: '通す', reasons: [], fixes: [], findings: [{ text: '重大X', likelihood: 'いつも', harm: '大', blocking: true }] }),
        response,
      ];
      const d = deps('');
      d.review = () => answers.shift()!;
      advance(f.ledger, 'repo-1', d, 1);
      f.ledger.setStatus('repo-1', '確かめ中', 'worker returned');
      f.ledger.releaseRunner('repo-1');
      advance(f.ledger, 'repo-1', d, 1);
      assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
      assert.match(f.ledger.get('repo-1')!.note!, /読めなかった/);
    } finally { f.done(); }
  }
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

test('a locale-specific missing-command diagnostic is detected without English wording', () => {
  const f = fixture({ check: 'definitely-not-a-real-check-command' });
  try {
    const d = deps('');
    const said = advance(f.ledger, 'repo-1', { ...d, sh: (command, cwd, timeout) => command === 'definitely-not-a-real-check-command'
      ? { code: 127, output: '診断メッセージの形式や言語に依存しない\\n' }
      : d.sh(command, cwd, timeout) }, 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.equal(f.ledger.get('repo-1')!.attempts, 1);
    assert.equal(f.ledger.spans('repo-1').find((item) => item.name === '確かめ')!.attributes['failure.kind'], 'environment');
    assert.match(said.join('\\n'), /環境の失敗/);
  } finally { f.done(); }
});

test('a missing command after cd is an environment failure, not a worker failure', () => {
  const f = fixture({ check: 'cd /tmp && definitely-not-a-real-check-command' });
  try {
    const calls: string[] = [];
    advance(f.ledger, 'repo-1', deps('', calls), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.equal(f.ledger.get('repo-1')!.attempts, 1);
    assert.ok(!calls.includes('resend'));
    assert.equal(f.ledger.spans('repo-1').find((item) => item.name === '確かめ')!.attributes['failure.kind'], 'environment');
  } finally { f.done(); }
});

test('a missing relative script is a worker failure, not an environment failure', () => {
  const f = fixture({ check: './not-yet.sh' });
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
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[],"findings":[{"text":"検査が中身を見ていない","likelihood":"いつも","harm":"大","blocking":true}]}', calls), 1);
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

test('when someone commits during a failed merged check, retry reapplies the revert and the task can merge again', () => {
  const f = fixture({ files: ['mul.js'], check: 'test -f only-in-worktree || { git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." -c user.name=t -c user.email=t@t commit -q --allow-empty -m "someone else"; exit 1; }' });
  try {
    writeFileSync(join(f.workdir, 'only-in-worktree'), '');
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '初回の報告\n');
    git(f.workdir, 'add', 'handoff/t-report.md'); git(f.workdir, 'commit', '-qm', 'initial report');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.match(git(f.repo, 'log', '--format=%s').trim(), /someone else/);
    assert.ok(!existsSync(join(f.repo, 'mul.js')), 'the merged work is undone');
    const undoEvent = f.ledger.events('repo-1').find((event) => event.note?.match(/取り消しコミット: ([0-9a-f]{40})/));
    assert.ok(undoEvent, 'the revert commit id is in the task event');
    f.ledger.db.prepare('UPDATE tasks SET "check"=? WHERE id=?').run('false', 'repo-1');
    f.ledger.setStatus('repo-1', '確かめ中', 'retry send-back'); f.ledger.releaseRunner('repo-1');
    const retryDeps = deps('');
    retryDeps.resend = (_task, _name) => {
      assert.equal(readFileSync(join(f.workdir, 'mul.js'), 'utf8'), 'export const mul = (a, b) => a * b;\n', 'the restored branch change exists before the worker starts');
      assert.match(git(f.workdir, 'log', '--format=%s'), /Revert/);
      assert.match(git(f.workdir, 'log', '--format=%s'), /someone else/);
      return 777;
    };
    advance(f.ledger, 'repo-1', retryDeps, 2);
    assert.equal(f.ledger.get('repo-1')!.status, '走行中');
    // The worker rewrites its existing report and edits the same file only after the revert is replayed.
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '出し直しの新しい報告\n終わりの条件: 満たした\n');
    writeFileSync(join(f.workdir, 'mul.js'), 'export const mul = (a, b) => a * b + 1;\n');
    git(f.workdir, 'add', 'mul.js', 'handoff/t-report.md'); git(f.workdir, 'commit', '-qm', 'worker fixes mul and report');
    f.ledger.db.prepare('UPDATE tasks SET "check"=? WHERE id=?').run('true', 'repo-1');
    f.ledger.setStatus('repo-1', '確かめ中', 'worker finished again'); f.ledger.releaseRunner('repo-1');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 3);
    assert.equal(f.ledger.get('repo-1')!.status, '済', f.ledger.get('repo-1')!.note ?? '');
    assert.equal(readFileSync(join(f.repo, 'mul.js'), 'utf8'), 'export const mul = (a, b) => a * b + 1;\n', 'the worker fix reaches the repository');
    assert.equal(readFileSync(join(f.repo, 'handoff/t-report.md'), 'utf8'), '出し直しの新しい報告\n終わりの条件: 満たした\n', 'the rewritten report reaches the repository');
    assert.match(git(f.workdir, 'log', '--format=%s'), /Revert/);
  } finally { f.done(); }
});

test('reapply treats every comma-separated processed revert id as recovered', () => {
  const f = fixture();
  try {
    const first = '1'.repeat(40); const second = '2'.repeat(40);
    f.ledger.setStatus('repo-1', '判断待ち', `取り消しコミット: ${first}（取り消した取り込み: ${'3'.repeat(40)}）`);
    f.ledger.setStatus('repo-1', '判断待ち', `取り消しコミット: ${second}（取り消した取り込み: ${'4'.repeat(40)}）`);
    f.ledger.setStatus('repo-1', '判断待ち', `再出しで枝を作り直した。過去の取り消しを処理済み: ${first},${second}`);
    const originalHead = git(f.workdir, 'rev-parse', 'HEAD').trim();
    assert.equal(reapplyRevertedMerge(f.ledger, f.ledger.get('repo-1')!, realAdvanceDeps), null);
    assert.equal(git(f.workdir, 'rev-parse', 'HEAD').trim(), originalHead, 'no processed revert is replayed');
  } finally { f.done(); }
});

test('reapply refuses non-handoff conflicts instead of choosing the worker branch', () => {
  const f = fixture({ files: ['math.js'] });
  try {
    // Repo and worker make incompatible changes after their shared base.
    writeFileSync(join(f.repo, 'math.js'), 'export const sub = (a, b) => a - b - 1;\n');
    git(f.repo, 'add', 'math.js'); git(f.repo, 'commit', '-qm', 'repo change');
    writeFileSync(join(f.workdir, 'math.js'), 'export const sub = (a, b) => a - b + 1;\n');
    git(f.workdir, 'add', 'math.js'); git(f.workdir, 'commit', '-qm', 'worker change');
    // Record a pending revert while leaving the independently changed repository and worker branches intact.
    const undo = '5'.repeat(40);
    f.ledger.setStatus('repo-1', '判断待ち', `取り消しコミット: ${undo}（取り消した取り込み: ${'6'.repeat(40)}）`);
    const result = reapplyRevertedMerge(f.ledger, f.ledger.get('repo-1')!, realAdvanceDeps);
    assert.ok((result ?? '').includes('handoff/ 以外の衝突'));
    assert.equal(git(f.workdir, 'rev-parse', 'HEAD').trim(), git(f.workdir, 'rev-parse', 'herdr/t').trim());
    assert.ok(!git(f.workdir, 'status', '--porcelain').includes('UU'));
  } finally { f.done(); }
});

// The repository merged the branch and then undid it (another commit sat on top), as a failed check after merging does.
function undoneByRevert(f: ReturnType<typeof fixture>, report?: string): { undo: string; merged: string } {
  if (report !== undefined) { writeFileSync(join(f.workdir, 'handoff/t-report.md'), report); git(f.workdir, 'add', 'handoff/t-report.md'); git(f.workdir, 'commit', '-qm', 'first report'); }
  git(f.repo, 'merge', '--no-ff', '-qm', 'task merge', 'herdr/t');
  const merged = git(f.repo, 'rev-parse', 'HEAD').trim();
  git(f.repo, 'commit', '--allow-empty', '-qm', 'someone else');
  git(f.repo, 'revert', '--no-edit', '-m', '1', merged);
  const undo = git(f.repo, 'rev-parse', 'HEAD').trim();
  f.ledger.setStatus('repo-1', '判断待ち', `本体に入れたあとの確かめが落ちたので戻した。取り消しコミット: ${undo}（取り消した取り込み: ${merged}）。`);
  return { undo, merged };
}
const clean = (cwd: string) => {
  assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'no unmerged or modified files are left');
  assert.throws(() => git(cwd, 'rev-parse', '-q', '--verify', 'REVERT_HEAD'), undefined, 'no revert is left half done');
  assert.throws(() => git(cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), undefined, 'no merge is left half done');
};

test('reapply keeps the worker branch\'s report when a hand-fixed report collides with the undo (merge and revert both conflict on handoff/)', () => {
  const f = fixture({ files: ['mul.js'] });
  const editor = process.env.GIT_EDITOR;
  try {
    undoneByRevert(f, '初回の報告\n');
    // The branch kept working after the merge: a report fixed by hand is committed in the copy.
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '手で直した報告\n終わりの条件: 満たした\n');
    git(f.workdir, 'add', 'handoff/t-report.md'); git(f.workdir, 'commit', '-qm', 'report fixed by hand');
    process.env.GIT_EDITOR = 'false'; // a reapply that opens an editor cannot finish
    assert.equal(reapplyRevertedMerge(f.ledger, f.ledger.get('repo-1')!, realAdvanceDeps), null);
    clean(f.workdir);
    assert.equal(readFileSync(join(f.workdir, 'handoff/t-report.md'), 'utf8'), '手で直した報告\n終わりの条件: 満たした\n', 'the branch side of the report stays');
    assert.equal(readFileSync(join(f.workdir, 'mul.js'), 'utf8'), 'export const mul = (a, b) => a * b;\n', 'the undone work is back on the branch');
    git(f.repo, 'merge', '--no-ff', '-qm', 'merge again', 'herdr/t');
    assert.equal(readFileSync(join(f.repo, 'mul.js'), 'utf8'), 'export const mul = (a, b) => a * b;\n', 'the branch change reaches the repository');
    assert.equal(readFileSync(join(f.repo, 'handoff/t-report.md'), 'utf8'), '手で直した報告\n終わりの条件: 満たした\n', 'and so does the new report');
  } finally { if (editor === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = editor; f.done(); }
});

test('reapply aborts a failing revert and leaves the worker copy clean when a file other than handoff/ collides', () => {
  const f = fixture({ files: ['mul.js'] });
  try {
    undoneByRevert(f);
    // Someone re-wrote the undone file in the repository; undoing the undo would put the old text over it.
    writeFileSync(join(f.repo, 'mul.js'), 'export const mul = (a, b) => b * a;\n');
    git(f.repo, 'add', 'mul.js'); git(f.repo, 'commit', '-qm', 'mul written again');
    const result = reapplyRevertedMerge(f.ledger, f.ledger.get('repo-1')!, realAdvanceDeps);
    assert.match(result ?? '', /取り消しの取り消しを作業用コピーに作れなかった/);
    clean(f.workdir);
    assert.equal(readFileSync(join(f.workdir, 'mul.js'), 'utf8'), 'export const mul = (a, b) => b * a;\n', 'the copy keeps what the repository had');
    assert.ok(!f.ledger.events('repo-1').some((event) => event.note?.includes('取り消しを再適用')), 'a failed reapply is not recorded as done');
  } finally { f.done(); }
});

test('reapply stops when handoff/ and another file collide together, leaving the copy as it was', () => {
  const f = fixture({ files: ['mul.js'] });
  try {
    undoneByRevert(f, '初回の報告\n');
    writeFileSync(join(f.workdir, 'handoff/t-report.md'), '手で直した報告\n');
    writeFileSync(join(f.workdir, 'mul.js'), 'export const mul = (a, b) => a * b + 2;\n');
    git(f.workdir, 'add', '-A'); git(f.workdir, 'commit', '-qm', 'hand-fixed report and mul');
    const before = git(f.workdir, 'rev-parse', 'HEAD').trim();
    assert.match(reapplyRevertedMerge(f.ledger, f.ledger.get('repo-1')!, realAdvanceDeps) ?? '', /handoff\/ 以外の衝突.*mul\.js/);
    clean(f.workdir);
    assert.equal(git(f.workdir, 'rev-parse', 'HEAD').trim(), before);
  } finally { f.done(); }
});

test('when failed merged check uses reset --keep, a retry still merges the work', () => {
  const f = fixture({ check: 'test -f only-in-worktree' });
  try {
    writeFileSync(join(f.workdir, 'only-in-worktree'), '');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 1);
    assert.equal(f.ledger.get('repo-1')!.status, '判断待ち');
    assert.ok(!f.ledger.events('repo-1').some((event) => event.note?.includes('取り消しコミット:')));
    f.ledger.db.prepare('UPDATE tasks SET "check"=? WHERE id=?').run('true', 'repo-1');
    f.ledger.setStatus('repo-1', '確かめ中', 'retry'); f.ledger.releaseRunner('repo-1');
    advance(f.ledger, 'repo-1', deps('{"verdict":"通す","reasons":[],"fixes":[]}'), 2);
    assert.equal(f.ledger.get('repo-1')!.status, '済');
    assert.ok(existsSync(join(f.repo, 'mul.js')));
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

test('review confirmation uses only the original major finding list and does not resume a full review session',()=>{
  const f=fixture();try{
    writeFileSync(join(f.workdir,'handoff/t-report.md'),'current report');mkdirSync(join(f.dir,'logs'),{recursive:true});
    let n=0;const calls:{prompt:string;session?:{sessionId?:string;resumePrompt?:string}}[]=[];const d=deps('');
    d.review=(prompt,_cwd,_dirs,session)=>{calls.push({prompt,session});n++;return {answer:n===1?'{"verdict":"通す","reasons":[],"fixes":[],"findings":[{"text":"fix","likelihood":"いつも","harm":"大","blocking":true}]}':'{"fixed":[1],"unfixed":[],"new":[]}',attributes:{'review.session_id':`s${n}`}};};
    advance(f.ledger,'repo-1',d,410);assert.equal(f.ledger.get('repo-1')!.status,'走行中');
    writeFileSync(join(f.workdir,'math.js'),'export const sub = (a, b) => a - b; // 修正内容だけ\n');git(f.workdir,'add','math.js');git(f.workdir,'commit','-qm','fix review finding');
    f.ledger.setStatus('repo-1','確かめ中','worker returned');f.ledger.releaseRunner('repo-1');
    advance(f.ledger,'repo-1',d,411);
    assert.equal(calls.length,2);assert.match(calls[1]!.prompt,/初回の大指摘一覧:[\s\S]*fix/);
    assert.match(calls[1]!.prompt,/直しの差分 .*review-confirmation-delta/);
    assert.doesNotMatch(calls[1]!.prompt,/diff-2\.log/);
    const deltaPath=calls[1]!.prompt.match(/直しの差分 ([^ ]+) のみ/)![1]!;assert.match(readFileSync(deltaPath,'utf8'),/修正内容だけ/);assert.doesNotMatch(readFileSync(deltaPath,'utf8'),/mul\.js/);
    assert.doesNotMatch(calls[1]!.prompt,/外の変更|前回のレビュー以後/);
    assert.equal(f.ledger.get('repo-1')!.status,'済');
    const confirmationSpan=f.ledger.spans('repo-1').filter(span=>span.name==='レビュー')[1]!;
    assert.equal(confirmationSpan.ok,true);assert.equal(confirmationSpan.attributes['review.verdict'],'確認:直った');assert.equal(confirmationSpan.attributes['review.unresolved'],'[]');
  }finally{f.done();}
});

test('catch-up conflicts after a passing review do not trigger another review, including after confirmation',()=>{
  for(const major of [false,true]){
    const f=fixture();try{
      writeFileSync(join(f.workdir,'math.js'),'export const sub = (a, b) => a - b; // worker version\n');git(f.workdir,'add','math.js');git(f.workdir,'commit','-qm','worker conflict');
      writeFileSync(join(f.repo,'math.js'),'export const sub = (a, b) => a - b; // repository version\n');git(f.repo,'add','math.js');git(f.repo,'commit','-qm','repository conflict');
      writeFileSync(join(f.workdir,'handoff/t-report.md'),'終わりの条件: 満たした\n');const calls:string[]=[];let n=0;const d=deps('',calls);
      d.review=(prompt)=>{calls.push(`review:${prompt}`);n++;return n===1&&major
        ?'{"verdict":"通す","reasons":[],"fixes":[],"findings":[{"text":"major","likelihood":"いつも","harm":"大","blocking":true}]}'
        :major&&n===2?'{"fixed":[1],"unfixed":[],"new":[]}':'{"verdict":"通す","reasons":[],"fixes":[]}';};
      advance(f.ledger,'repo-1',d,500);
      if(major){assert.equal(f.ledger.get('repo-1')!.status,'走行中');f.ledger.setStatus('repo-1','確かめ中','worker fixed');f.ledger.releaseRunner('repo-1');advance(f.ledger,'repo-1',d,501);}
      assert.equal(f.ledger.get('repo-1')!.status,'走行中');assert.match(f.ledger.get('repo-1')!.note!,/差し戻し:.*衝突/);
      writeFileSync(join(f.workdir,'math.js'),'export const sub = (a, b) => a - b; // conflict resolved\n');git(f.workdir,'add','math.js');git(f.workdir,'commit','-qm','resolve catch-up conflict');
      f.ledger.setStatus('repo-1','確かめ中','worker resolved');f.ledger.releaseRunner('repo-1');advance(f.ledger,'repo-1',d,502);
      assert.equal(f.ledger.get('repo-1')!.status,'済');assert.equal(n,major?2:1);
    }finally{f.done();}
  }
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

test('real review returns the launch values it passed to claude, also when the answer is not JSON', () => {
  const dir=mkdtempSync(join(tmpdir(),'review-model-')),oldBin=process.env.TASK_CLAUDE_BIN,bin=join(dir,'claude'),argsFile=join(dir,'args');
  const expected={'model.role':'レビュー役','model.agent':'Claude','model.provider':'anthropic','model.model':'opus','model.effort':'指定なし（claude の既定）','model.fast':false};
  try {process.env.TASK_CLAUDE_BIN=bin;
    writeFileSync(bin,`#!/bin/sh\nprintf '%s\\n' "$*" > '${argsFile}'\ncat > /dev/null\nprintf '%s' '{"result":"ok","session_id":"s1","total_cost_usd":0.5}'\n`);chmodSync(bin,0o755);
    const good=realAdvanceDeps.review('p','/tmp',[dir],{sessionId:'new-id'});assert.equal(typeof good,'object');
    const args=readFileSync(argsFile,'utf8');assert.match(args,/--model opus /);assert.doesNotMatch(args,/--effort/); // 渡した引数どおりの値を記録する
    assert.deepEqual({...(good as {attributes:Record<string,unknown>}).attributes},{...expected,'review.session_id':'s1','review.cost_usd':0.5});
    writeFileSync(bin,'#!/bin/sh\ncat > /dev/null\necho "not json"\nexit 3\n');
    const bad=realAdvanceDeps.review('p','/tmp',[dir],{sessionId:'new-id'});assert.equal(typeof bad,'object');
    assert.deepEqual((bad as {attributes:Record<string,unknown>}).attributes,expected);assert.match((bad as {answer:string}).answer,/not json/);
  } finally {if(oldBin===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldBin;rmSync(dir,{recursive:true,force:true});}
});
