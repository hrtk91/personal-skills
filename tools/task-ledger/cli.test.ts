import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realAdvanceDeps, type AdvanceDeps } from './advance.ts';
import { Ledger } from './ledger.ts';

test('Goal, Issue, docs, priorities and task context through CLI', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-context-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=(...args:string[])=>{const lines:string[]=[];const code=main(args,t=>lines.push(t));return{code,text:lines.join('\n')}};
  try {
    const repo=join(dir,'repo');const goal=run('goal','add','--repo',repo,'--title','Goal','--why','発言');assert.equal(goal.code,0);assert.match(goal.text,/repo-g1/);
    const issue=run('issue','add','--repo',repo,'--title','Issue','--body','Details','--by','Claude','--goal','repo-g1','--stage','設計','--今の状態','現在の事実','--関係する所','tools/a.ts');assert.equal(issue.code,0);assert.match(issue.text,/repo-i1/);
    assert.equal(run('doc','add','--repo',repo,'--kind','仕様','--title','Spec','--path','handoff/spec.md','--goal','repo-g1').code,0);
    assert.match(run('add','--repo',repo,'--title','task','--why','w','--issue','repo-i1').text,/repo-1/);
    assert.match(run('issue','list','--goal','repo-g1').text,/Issue/);
    const context=run('context','repo-1').text;assert.match(context,/Goal/);assert.doesNotMatch(context,/Details/);assert.ok(context.includes('handoff/spec.md'));
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

test('retro CLI reads JSON traces and filters open issues by creator', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-retro-cli-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=runner(main),repo=join(dir,'repo');
  try {
    assert.equal(run('issue','add','--repo',repo,'--title','Watch','--by','見張り役').code,0);
    assert.equal(run('issue','add','--repo',repo,'--title','Other','--by','Claude').code,0);
    const watcher=run('issue','list','--by','見張り役','--open');assert.equal(watcher.code,0);assert.match(watcher.text,/Watch/);assert.doesNotMatch(watcher.text,/Other/);
    assert.equal(run('issue','list','--by','見張り役','--open').code,0);
    const traces=run('report','--since','1970-01-01T00:00:00Z','--json');assert.equal(traces.code,0);assert.deepEqual(JSON.parse(traces.text),[]);
    assert.equal(run('issue','add','--repo',repo,'--title','Bad','--by','someone').code,1);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('issue Markdown import, required context validation, task generation and show/template', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-issue-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(join(repo,'handoff'),{recursive:true});mkdirSync(join(repo,'tools'),{recursive:true});writeFileSync(join(repo,'tools','a.ts'),'');
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

test('task add --issue validates check and file fields, supports overrides, and writes the issue brief', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-issue-check-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(join(repo,'tools'),{recursive:true});writeFileSync(join(repo,'tools','a.ts'),'');
  const run=runner(main);
  try {
    assert.equal(run('issue','add','--repo',repo,'--title','Guard','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','差し戻しを含む仕事を流し、結果を見る','--触るファイル','tools/a.ts').code,0);
    const prose=run('add','--repo',repo,'--issue','repo-i1');
    assert.equal(prose.code,1);assert.match(prose.err,/コマンドに見えません/);assert.match(prose.err,/--check/);
    const overridden=run('add','--repo',repo,'--issue','repo-i1','--check','node --test');
    assert.equal(overridden.code,0,overridden.err);
    assert.match(JSON.parse(run('show','repo-1').text.split('\n}')[0]+'\n}').check,/node --test/);
    assert.equal(readFileSync(join(repo,'handoff','repo-i1.md'),'utf8'),run('issue','brief','repo-i1').text+'\n');

    assert.equal(run('issue','add','--repo',repo,'--title','Files','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','npm test','--触るファイル','tools/a.ts、tools/a.ts').code,0);
    assert.equal(run('add','--repo',repo,'--issue','repo-i2').code,0);
    assert.deepEqual(JSON.parse(run('show','repo-2').text.split('\n}')[0]+'\n}').files,['tools/a.ts','tools/a.ts']);

    assert.equal(run('issue','add','--repo',repo,'--title','Missing','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','npm test','--触るファイル','tools/a.ts、unknown/missing.ts').code,0);
    const invalid=run('add','--repo',repo,'--issue','repo-i3');
    assert.equal(invalid.code,1);assert.ok(invalid.err.includes('unknown/missing.ts'));assert.match(invalid.err,/--files/);
    assert.equal(run('add','--repo',repo,'--issue','repo-i3','--files','tools/a.ts').code,0);

    assert.equal(run('issue','add','--repo',repo,'--title','New target','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','npm test','--触るファイル','tools/new.ts').code,0);
    const newTarget=run('add','--repo',repo,'--issue','repo-i4');assert.equal(newTarget.code,0,newTarget.err);
    assert.deepEqual(JSON.parse(run('show','repo-4').text.split('\n}')[0]+'\n}').files,['tools/new.ts']);

    assert.equal(run('issue','add','--repo',repo,'--title','Prose path','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','npm test','--触るファイル','tools/a.ts、tools/ の差し戻しの記録まわり').code,0);
    const prosePath=run('add','--repo',repo,'--issue','repo-i5');
    assert.equal(prosePath.code,1);assert.ok(prosePath.err.includes('tools/ の差し戻しの記録まわり'));assert.match(prosePath.err,/--files/);

    assert.equal(run('issue','add','--repo',repo,'--title','Existing brief','--なぜ','reason','--今の状態','known','--関係する所','tools/a.ts','--確かめのコマンド','npm test','--触るファイル','tools/a.ts').code,0);
    writeFileSync(join(repo,'handoff','repo-i6.md'),'keep this brief');
    assert.equal(run('add','--repo',repo,'--issue','repo-i6').code,0);
    assert.equal(readFileSync(join(repo,'handoff','repo-i6.md'),'utf8'),'keep this brief');
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

test('task add accepts worker settings and design session; show/list expose them but context omits them', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-worker-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=runner(main),repo=join(dir,'repo');
  try {
    const added=run('add','--repo',repo,'--title','Claude work','--why','w','--worker','claude','--model','haiku','--effort','high','--design-session','design-abc');
    assert.equal(added.code,0,added.err);
    assert.match(added.text,/\[claude\/haiku\/high\]/);
    assert.match(run('show','repo-1').text, /"worker": "claude"[\s\S]*"model": "haiku"[\s\S]*"effort": "high"[\s\S]*"design_session": "design-abc"/);
    assert.match(run('list').text,/claude\/haiku\/high/);
    assert.doesNotMatch(run('context','repo-1').text,/作業役とモデル|worker:|model:|effort:/);
    const bad=run('add','--repo',repo,'--title','bad','--why','w','--worker','agent');
    assert.equal(bad.code,1);assert.match(bad.err,/--worker/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('task add / brief / ready / answer / export through the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-ledger-'));
  process.env.TASK_LEDGER_DB = join(dir, 'ledger.sqlite');
  const { main } = await import('./cli.ts');
  const repo = join(dir, 'repo'); mkdirSync(join(repo, 'handoff'), { recursive: true }); writeFileSync(join(repo, 'handoff/a.md'), '## 困りごと\n問題\n\n## やること\n実施\n\n## やってよいこと\nこの写し\n\n## やらないこと\nなし\n\n## 終わりの条件\n- 確かめのコマンドが通る。報告の 1 行目に「終わりの条件: 満たした」か「満たしていない — 何が」。\n');
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

// The harness's reviewer and clean-up are replaced, so the answer runs the real check and merge but never calls claude.
const answerAdvanceDeps = (): AdvanceDeps => ({
  ...realAdvanceDeps,
  sh: (command, cwd, timeout) => command.includes('--cleanup') ? { code: 0, output: '' } : realAdvanceDeps.sh(command, cwd, timeout),
  review: () => '{"verdict":"通す","reasons":[],"fixes":[]}',
  quota: () => ({ claudeRemaining: 50, codexRemaining: 50 }),
  resend: () => 4242,
  pause: () => {},
});

for (const target of ['確かめ中', '取り込み中']) {
  test(`task answer --to ${target} reapplies a reverted merge, then the harness merges the branch again`, async () => {
    const dir=mkdtempSync(join(tmpdir(),'task-ledger-answer-reapply-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
    const run=runner((argv,out)=>main(argv,out,{start:()=>4242,advance:()=>{},alive:()=>true,load:()=>0},answerAdvanceDeps()));
    const repo=join(dir,'repo'), workdir=join(dir,'worktree');mkdirSync(join(repo,'handoff'),{recursive:true});
    const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    try {
      git(repo,'init','-q','-b','main');writeFileSync(join(repo,'PRINCIPLES.md'),'## Principles\n1. **Test principle**\n');writeFileSync(join(repo,'base.txt'),'base\n');git(repo,'add','base.txt');git(repo,'commit','-qm','base');
      git(repo,'worktree','add','-q','-b','herdr/reapply',workdir,'HEAD');writeFileSync(join(workdir,'feature.txt'),'worker change\n');git(workdir,'add','feature.txt');git(workdir,'commit','-qm','worker change');
      git(repo,'merge','--no-ff','-m','task merge','herdr/reapply');const merged=git(repo,'rev-parse','HEAD');writeFileSync(join(repo,'other.txt'),'other commit\n');git(repo,'add','other.txt');git(repo,'commit','-qm','someone else');git(repo,'revert','--no-edit','-m','1',merged);const reverted=git(repo,'rev-parse','HEAD');
      writeFileSync(join(repo,'handoff/reapply.md'),'## 困りごと\n問題\n\n## やること\n再開\n\n## やってよいこと\n一時 repo\n\n## やらないこと\n本物の repo\n\n## 終わりの条件\n終わりの条件: 満たした\n');
      git(repo,'add','handoff/reapply.md');git(repo,'commit','-qm','brief');
      assert.equal(run('add','--repo',repo,'--title','Resume','--why','w','--brief','handoff/reapply.md','--check','true').code,0);
      const {Ledger}=await import('./ledger.ts');const ledger=new Ledger();ledger.setStatus('repo-1','走行中','started',{attempts:1});ledger.setRunner('repo-1',{workdir});ledger.setStatus('repo-1','判断待ち',`取り消しコミット: ${reverted}（取り消した取り込み: ${merged}）`);
      const stateBefore=git(workdir,'rev-parse','HEAD');ledger.close();
      mkdirSync(join(workdir,'handoff'),{recursive:true});writeFileSync(join(workdir,'handoff/reapply-report.md'),'終わりの条件: 満たした\n');
      const answered=run('answer','repo-1','手で直したので進める','--to',target,'--principle','repo:1');assert.equal(answered.code,0,answered.err);
      assert.notEqual(git(workdir,'rev-parse','HEAD'),stateBefore,'the branch moved on');
      assert.match(git(workdir,'log','--format=%s'),/Revert/,'the revert-of-revert was committed on the worker branch');
      assert.equal(readFileSync(join(workdir,'feature.txt'),'utf8'),'worker change\n','the reverted feature is restored on the branch');
      const after=new Ledger();const task=after.get('repo-1')!;const note=task.note??'';after.close();
      assert.equal(task.status,'済',note+answered.text);
      assert.equal(readFileSync(join(repo,'feature.txt'),'utf8'),'worker change\n','the harness merged the worker branch change into the repository');
    } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
  });
}

test('task answer --attempts sets the requested count and zero cleans the previous worktree', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-answer-attempts-'));
  process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');
  const {main}=await import('./cli.ts');
  const repo=join(dir,'repo'), copy=join(dir,'work','wt','resume');
  mkdirSync(repo,{recursive:true});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const run=runner((argv,out)=>main(argv,out,{start:()=>4242,advance:()=>{},alive:()=>true,load:()=>0}));
  try {
    git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');writeFileSync(join(repo,'PRINCIPLES.md'),'## Principles\n1. **Test principle**\n');
    mkdirSync(join(repo,'handoff'),{recursive:true});
    writeFileSync(join(repo,'handoff','resume.md'),'## 困りごと\n問題\n\n## やること\n実施\n\n## やってよいこと\nこの写し\n\n## やらないこと\nなし\n\n## 終わりの条件\n終わりの条件: 満たした\n');
    writeFileSync(join(repo,'base.txt'),'base');git('add','base.txt');git('commit','-m','base');
    mkdirSync(join(dir,'work','wt'),{recursive:true});git('worktree','add','-b','herdr/resume',copy,'HEAD');
    assert.equal(run('add','--repo',repo,'--title','Answer','--why','w','--brief','handoff/resume.md').code,0);
    const ledger=new (await import('./ledger.ts')).Ledger();
    ledger.setStatus('repo-1','走行中','started',{attempts:1});ledger.setRunner('repo-1',{workdir:copy});ledger.setStatus('repo-1','判断待ち','need answer');ledger.releaseRunner('repo-1');ledger.close();
    const answered=run('answer','repo-1','main 比較をする','--to','待ち','--attempts','2','--principle','repo:1');
    assert.equal(answered.code,0,answered.err);
    assert.match(run('show','repo-1').text, /"attempts": 2/);
    assert.match(run('context','repo-1').text,/## 判断待ちへの答え[\s\S]*main 比較をする/);

    const ledger2=new (await import('./ledger.ts')).Ledger();
    ledger2.setStatus('repo-1','走行中','started',{attempts:2});ledger2.setRunner('repo-1',{workdir:copy});ledger2.setStatus('repo-1','判断待ち','again');ledger2.releaseRunner('repo-1');ledger2.close();
    const reset=run('answer','repo-1','やり直す','--to','待ち','--attempts','0','--principle','repo:1');
    assert.equal(reset.code,0,reset.err);
    assert.equal(run('run').code,0);
    assert.equal(git('worktree','list','--porcelain').includes(`worktree ${copy}`),false);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('task add and task brief enforce brief format; task add bounds top-level --files unless explicitly broad', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-intake-check-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const repo=join(dir,'repo');mkdirSync(join(repo,'src'),{recursive:true});mkdirSync(join(repo,'test'));mkdirSync(join(repo,'web','app','features','mobile'),{recursive:true});mkdirSync(join(repo,'handoff'));
  const run=runner(main), valid='## 困りごと\n問題\n\n## やること\n実施\n\n## やってよいこと\nこの写し\n\n## やらないこと\n本体には書かない\n\n## 終わりの条件\n- 確かめのコマンドが通る。報告の 1 行目に「終わりの条件: 満たした」か「満たしていない — 何が」。\n';
  const full=join(repo,'handoff','full.md'),missing=join(repo,'handoff','missing.md'),missingEnd=join(repo,'handoff','missing-end.md');writeFileSync(full,valid);writeFileSync(missing,'## 困りごと\n問題\n## やること\n実施\n## 終わりの条件\n終わりの条件: 満たした\n');writeFileSync(missingEnd,valid.replace('「終わりの条件: 満たした」','「終わりの条件: 完了」'));
  try {
    const noHeadings=run('add','--repo',repo,'--title','Missing','--why','w','--brief','handoff/missing.md');
    assert.equal(noHeadings.code,1);assert.match(noHeadings.err,/## やってよいこと/);assert.equal(run('list','--repo',repo).text,'');
    const noEndPhrase=run('add','--repo',repo,'--title','Missing phrase','--why','w','--brief','handoff/missing-end.md');
    assert.equal(noEndPhrase.code,1);assert.match(noEndPhrase.err,/節内に、報告の1行目/);assert.equal(run('list','--repo',repo).text,'');
    const tooBroad=run('add','--repo',repo,'--title','Valid','--why','w','--brief','handoff/full.md','--files','src,test');
    assert.equal(tooBroad.code,1);assert.match(tooBroad.err,/ファイルか、もっと下のフォルダ/);
    const allowed=run('add','--repo',repo,'--title','Valid','--why','w','--brief','handoff/full.md','--files','src/timeline.ts,web/app/features/mobile,handoff');
    assert.equal(allowed.code,0,allowed.err);
    assert.deepEqual(JSON.parse(run('show','repo-1').text.split('\n}')[0]+'\n}').files,['src/timeline.ts','web/app/features/mobile','handoff']);
    const broad=run('add','--repo',repo,'--title','Broad','--why','w','--brief','handoff/full.md','--files','src','--files-broad');assert.equal(broad.code,0,broad.err);
    assert.equal(run('add','--repo',repo,'--title','Empty','--why','w','--brief','handoff/full.md','--files','').code,1);
    assert.equal(run('add','--repo',repo,'--title','Brief later','--why','w').code,0);
    assert.equal(run('brief','repo-3','handoff/missing.md').code,1);
    const setBrief=run('brief','repo-3','handoff/full.md');assert.equal(setBrief.code,0,setBrief.err);
    assert.match(setBrief.text,/待ち/);
    const actualBrief=run('add','--repo',repo,'--title','Real intake brief','--why','regression','--brief',handoff('intake-check.md'));
    assert.equal(actualBrief.code,0,actualBrief.err);assert.match(actualBrief.text,/Real intake brief/);
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('model-run records the launch values of an attempt as a span, and refuses a wrong role or task', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-ledger-model-run-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');
  const run=(...args:string[])=>{const lines:string[]=[];const code=main(args,t=>lines.push(t));return{code,text:lines.join('\n')}};
  try {
    assert.match(run('add','--repo',join(dir,'repo'),'--title','t','--why','w').text,/repo-1/);
    assert.equal(run('model-run','repo-1','--role','作業役','--agent','Pi','--provider','openai-codex','--model','gpt-6-luna','--effort','high').code,0);
    assert.equal(run('model-run','repo-1','--role','作業役','--agent','Pi','--provider','openai-codex','--model','gpt-6-luna','--effort','low','--fast').code,0);
    const ledger=new Ledger(join(dir,'db.sqlite'));
    try {const spans=ledger.spans('repo-1');assert.equal(spans.length,2);
      assert.deepEqual(spans[0]!.attributes,{'model.role':'作業役','model.agent':'Pi','model.provider':'openai-codex','model.model':'gpt-6-luna','model.effort':'high','model.fast':false});
      assert.deepEqual([spans[1]!.attributes['model.effort'],spans[1]!.attributes['model.fast']],['low',true]);
    } finally {ledger.close();}
    assert.equal(run('model-run','repo-1','--role','誰か','--agent','Pi').code,1);
    assert.equal(run('model-run','nothing-1','--role','作業役').code,1);
    assert.equal(new Ledger(join(dir,'db.sqlite')).spans('repo-1').length,2); // 断られた分は残らない
  } finally {rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});

test('principle, goal and feedback CLI operations persist on a temporary ledger',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'task-ledger-answer-cli-'));process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');const {main}=await import('./cli.ts');const run=runner(main),repo=join(dir,'repo');mkdirSync(repo,{recursive:true});writeFileSync(join(repo,'PRINCIPLES.md'),'## Principles\n1. **Use evidence**\n## 大事な価値基準\n3. **Value**\n');
 try{
  assert.equal(run('goal','add','--repo',repo,'--title','Epic').code,0);
  assert.equal(run('add','--repo',repo,'--title','Answer','--why','test','--goal','repo-g1').code,0);
  let ledger=new Ledger();ledger.setStatus('repo-1','判断待ち','question');ledger.close();
  assert.equal(run('answer','repo-1','answer').code,1);
  assert.equal(run('answer','repo-1','answer','--principle','repo:1').code,0);
  ledger=new Ledger();ledger.setStatus('repo-1','判断待ち','again');ledger.close();
  assert.equal(run('answer','repo-1','answer','--principle','repo:価値基準3').code,0);
  ledger=new Ledger();ledger.setStatus('repo-1','判断待ち','again');ledger.close();
  assert.equal(run('answer','repo-1','answer','--principle','other:1').code,1);
  assert.equal(run('principle','propose','--target',repo,'--text','Use a rule','--quote','Because').code,0);
  assert.equal(run('principle','list','--status','案').code,0);
  assert.equal(run('principle','mark','1','直して入れる','--final','Revised rule').code,0);
  assert.equal(run('principle','list','--json').code,0);
  assert.equal(run('goal','set','repo-1','none').code,0);
  assert.equal(run('feedback','list','--json').text,'[]');
  const db=new Ledger();assert.equal(db.get('repo-1')?.goal_id,null);assert.equal((db.db.prepare('SELECT by,principle FROM answers').get() as any).by,'Claude');db.close();
 }finally{rmSync(dir,{recursive:true,force:true});delete process.env.TASK_LEDGER_DB;}
});
