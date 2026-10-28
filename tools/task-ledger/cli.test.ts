import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Goal, Issue, docs, priorities and task context through CLI', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-context-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=(...args:string[])=>{const lines:string[]=[];const code=main(args,t=>lines.push(t));return{code,text:lines.join('\n')}};
  try {
    const repo=join(dir,'repo');const goal=run('goal','add','--repo',repo,'--title','Goal','--why','発言');assert.equal(goal.code,0);assert.match(goal.text,/repo-g1/);
    const issue=run('issue','add','--repo',repo,'--title','Issue','--body','Details','--by','Claude','--goal','repo-g1','--stage','設計','--今の状態','現在の事実','--関係する所','tools/a.ts');assert.equal(issue.code,0);assert.match(issue.text,/repo-i1/);
    assert.equal(run('doc','add','--repo',repo,'--kind','仕様','--title','Spec','--path','handoff/spec.md','--goal','repo-g1').code,0);
    assert.match(run('add','--repo',repo,'--title','task','--why','w','--issue','repo-i1').text,/repo-1/);
    assert.match(run('issue','list','--goal','repo-g1').text,/Issue/);
    const context=run('context','repo-1').text;assert.match(context,/Goal/);assert.match(context,/Details/);assert.ok(context.includes('handoff/spec.md'));
    assert.equal(run('priority','repo-1','first').code,0);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('issue Markdown import, required context validation, task generation and show/template', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-issue-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(join(repo,'handoff'),{recursive:true});
  const path=join(dir,'issue.md');
  const run=(...args:string[])=>{const lines:string[]=[];const code=main(args,t=>lines.push(t));return{code,text:lines.join('\n')}};
  try {
    writeFileSync(path,'# Legacy issue\n\n<!-- ignored -->\n## なぜ\n理由\n\n## やること\n実施\n');
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    assert.equal(run('add','--repo',repo,'--issue','repo-i1').code,1);
    assert.equal(run('issue','add','--repo',repo,'--from','handoff/issue-template.md').code,0);
    assert.equal(run('add','--repo',repo,'--issue','repo-i2').code,1);
    writeFileSync(path,'# Feature\n\n<!-- removed -->\n## なぜ\n必要\n\n## 今の状態（必須）\n実際の現在\n\n## 関係する所（必須）\n- tools/a.ts\n\n## やること\n実装\n\n## 確かめのコマンド\nnpm test\n\n## 触るファイル\ntools/a.ts\n');
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    const created=run('add','--repo',repo,'--issue','repo-i3');assert.match(created.text,/repo-1\t待ち\tFeature/);
    const brief=run('issue','brief','repo-i3').text;
    assert.ok(brief.indexOf('## なぜ')<brief.indexOf('## 今の状態'));
    assert.match(brief,/## 関係する所[\s\S]*tools\/a\.ts/);
    assert.ok(!brief.includes('ignored'));
    assert.match(run('issue','show','repo-i3').text,/"goal": null/);
    assert.match(run('issue','template').text,/## 今の状態/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('the requested dashboard brief initially lacks required template context; marked additions make it actionable', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-dashboard-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(repo);
  const run=(...args:string[])=>{const lines:string[]=[];const code=main(args,t=>lines.push(t));return{code,text:lines.join('\n')}};
  try {
    assert.equal(run('issue','add','--repo',repo,'--from','handoff/dashboard-issue-brief.md').code,0);
    assert.equal(run('add','--repo',repo,'--issue','repo-i1').code,1);
    const original=readFileSync(new URL('../../handoff/dashboard-issue-brief.md',import.meta.url),'utf8');
    const copy=join(dir,'dashboard-issue-brief.md');
    writeFileSync(copy,`${original}\n## 今の状態（必須）\n検査で確認した現在の状態\n\n## 関係する所（必須）\n- tools/task-ledger/ledger.ts\n`);
    assert.equal(run('issue','add','--repo',repo,'--from',copy).code,0);
    assert.match(run('add','--repo',repo,'--issue','repo-i2').text,/repo-1\t待ち/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('task add / brief / ready / answer / export through the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-ledger-'));
  process.env.TASK_LEDGER_DB = join(dir, 'ledger.sqlite');
  const { main } = await import('./cli.ts');
  const repo = join(dir, 'repo'); mkdirSync(join(repo, 'handoff'), { recursive: true }); writeFileSync(join(repo, 'handoff/a.md'), 'brief');
  const run = (...args: string[]) => { const lines: string[] = []; const code = main(args, (t) => lines.push(t)); return { code, text: lines.join('\n') }; };
  try {
    assert.match(run('add', '--repo', repo, '--title', 'A を直す', '--why', '「直して」10/27').text, /repo-1\t依頼文待ち\tA を直す/);
    assert.equal(run('add', '--repo', repo, '--title', 'B', '--why', 'w', '--brief', 'handoff/missing.md').code, 1);
    assert.match(run('brief', 'repo-1', 'handoff/a.md', '--check', 'npm test').text, /待ち/);
    assert.match(run('ready').text, /repo-1/);
    assert.equal(run('answer', 'repo-1', 'はい').code, 1);
    run('hold', 'repo-1', '待つ');
    assert.equal(run('answer', 'repo-1', '直した', '--to', '確かめ中').code, 1);
    run('drop', 'repo-1', '要らない');
    assert.match(run('list', '--all').text, /やめ/);
    assert.match(run('export', '--repo', repo).text, /^# ROADMAP/);
  } finally { rmSync(dir, { recursive: true, force: true }); delete process.env.TASK_LEDGER_DB; }
});
