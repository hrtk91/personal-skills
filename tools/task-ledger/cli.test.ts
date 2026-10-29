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

// Runs the command and collects what it prints, including the refusal on stderr.
function runner(main: (argv: string[], out: (t: string) => void) => number) {
  return (...args: string[]) => {
    const lines: string[] = [], errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try { const code = main(args, (t) => lines.push(t)); return { code, text: lines.join('\n'), err: errors.join('\n') }; }
    finally { console.error = error; }
  };
}
const handoff = (name: string) => new URL(`../../handoff/${name}`, import.meta.url).pathname;

test('issue Markdown import, required context validation, task generation and show/template', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-issue-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(join(repo,'handoff'),{recursive:true});
  const path=join(dir,'issue.md');
  const run=runner(main);
  try {
    writeFileSync(path,'# Legacy issue\n\n<!-- ignored -->\n## なぜ\n理由\n\n## やること\n実施\n');
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    assert.equal(run('add','--repo',repo,'--issue','repo-i1').code,1);
    writeFileSync(path,'# Feature\n\n<!-- removed -->\n## なぜ\n必要\n\n## 今の状態（必須）\n実際の現在\n\n## 関係する所（必須）\n- tools/a.ts\n\n## やること\n実装\n\n## 確かめのコマンド\nnpm test\n\n## 触るファイル\ntools/a.ts\n');
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    const created=run('add','--repo',repo,'--issue','repo-i2');assert.match(created.text,/repo-1\t待ち\tFeature/);
    const brief=run('issue','brief','repo-i2').text;
    assert.ok(brief.indexOf('## なぜ')<brief.indexOf('## 今の状態'));
    assert.match(brief,/## 関係する所[\s\S]*tools\/a\.ts/);
    assert.ok(!brief.includes('ignored'));
    assert.match(run('issue','show','repo-i2').text,/"goal": null/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('plain 「## 今の状態」「## 関係する所」 headings count, with or without （必須）', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-plain-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(repo);const path=join(dir,'issue.md');const run=runner(main);
  try {
    writeFileSync(path,'# Plain\n\n## なぜ\n必要\n\n## 今の状態\n測った事実\n\n## 関係する所\n- tools/a.ts\n\n## 終わりの条件（自分で流して、出力を報告に貼る）\n通る\n確かめのコマンド: `npm test`\n');
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    const fields=JSON.parse(run('issue','show','repo-i1').text).fields;
    assert.equal(fields['今の状態'],'測った事実');
    assert.equal(fields['関係する所'],'- tools/a.ts');
    assert.match(fields['終わりの条件'],/^通る/);
    assert.equal(fields['確かめのコマンド'],'npm test');
    const added=run('add','--repo',repo,'--issue','repo-i1');
    assert.equal(added.code,0,added.err);
    assert.equal(JSON.parse(run('show','repo-1').text.split('\n}')[0]+'\n}').check,'npm test');
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('task issue template prints handoff/issue-template.md, and the template left as is is refused', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-template-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(repo);const path=join(dir,'template.md');const run=runner(main);
  try {
    const template=run('issue','template');
    assert.equal(template.code,0);
    assert.equal(template.text,readFileSync(handoff('issue-template.md'),'utf8').trimEnd());
    writeFileSync(path,template.text);
    assert.equal(run('issue','add','--repo',repo,'--from',path).code,0);
    const refused=run('add','--repo',repo,'--issue','repo-i1');
    assert.equal(refused.code,1);
    assert.match(refused.err,/今の状態/);
    assert.match(refused.err,/関係する所/);
    assert.equal(JSON.parse(run('issue','show','repo-i1').text).fields['確かめのコマンド'],undefined);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('an existing brief: fields are read, other sections survive into the brief, and missing context is refused until added', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-dashboard-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(repo);
  const run=runner(main);
  try {
    // handoff/explore-first-ab.md has no 今の状態 / 関係する所.
    assert.equal(run('issue','add','--repo',repo,'--from',handoff('explore-first-ab.md')).code,0);
    const fields=JSON.parse(run('issue','show','repo-i1').text).fields;
    assert.match(fields['なぜ'],/^ユーザー（10\/28 夜）/);
    assert.match(fields['やってよいこと'],/PI_SYSTEM_PROMPT/);
    assert.match(fields['やらないこと'],/pi-system\.md/);
    assert.match(fields['終わりの条件'],/8 回分の表/);
    assert.equal(fields['今の状態'],undefined);
    const brief=run('issue','brief','repo-i1').text;
    assert.match(brief,/## 設計（Claude が決めた）[\s\S]*比べる 2 つ/);
    assert.match(brief,/## 報告\n`handoff\/explore-first-ab-report\.md`/);
    assert.ok(brief.indexOf('## 本番に出すか')<brief.indexOf('## 設計'));
    const refused=run('add','--repo',repo,'--issue','repo-i1');
    assert.equal(refused.code,1);
    assert.equal(refused.err,'Issue の文脈が不足: 今の状態、関係する所');

    const original=readFileSync(handoff('explore-first-ab.md'),'utf8');
    const copy=join(dir,'explore-first-ab.md');
    writeFileSync(copy,original.replace('## やってよいこと','## 今の状態\n過去の仕事 4 本は台帳に記録がある。\n\n## 関係する所\n- skills/herdr/herdr-run.sh\n\n## やってよいこと'));
    assert.equal(run('issue','add','--repo',repo,'--from',copy).code,0);
    assert.match(run('add','--repo',repo,'--issue','repo-i2').text,/repo-1\t待ち/);

    // handoff/dashboard-issue-brief.md already has both sections.
    assert.equal(run('issue','add','--repo',repo,'--from',handoff('dashboard-issue-brief.md')).code,0);
    const added=run('add','--repo',repo,'--issue','repo-i3');
    assert.equal(added.code,0,added.err);
    assert.match(added.text,/repo-2\t待ち/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('task add accepts worker settings and show/list/context expose them', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-worker-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=runner(main),repo=join(dir,'repo');
  try {
    const added=run('add','--repo',repo,'--title','Claude work','--why','w','--worker','claude','--model','haiku','--effort','high');
    assert.equal(added.code,0,added.err);
    assert.match(added.text,/\[claude\/haiku\/high\]/);
    assert.match(run('show','repo-1').text, /"worker": "claude"[\s\S]*"model": "haiku"[\s\S]*"effort": "high"/);
    assert.match(run('list').text,/claude\/haiku\/high/);
    assert.match(run('context','repo-1').text,/worker: claude[\s\S]*model: haiku[\s\S]*effort: high/);
    const bad=run('add','--repo',repo,'--title','bad','--why','w','--worker','agent');
    assert.equal(bad.code,1);assert.match(bad.err,/--worker/);
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
