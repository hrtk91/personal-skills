import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { advance, parseVerdict, type AdvanceDeps } from './advance.ts';
import { metrics } from './metrics.ts';
import { main } from './cli.ts';
import { realAdvanceDeps } from './advance.ts';

function fixture() {
  const dir = mkdtempSync('/tmp/review-severity-');
  process.env.TASK_LEDGER_DB = join(dir, 'ledger.sqlite');
  if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = '/bin/true';
  const repo = join(dir, 'repo');
  const git = (...args: string[]) => execFileSync('git', ['-c','user.name=t','-c','user.email=t@x',...args], { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(repo,'handoff'), { recursive: true }); git('init','-q','-b','main');
  writeFileSync(join(repo,'handoff/t.md'),'# task\n'); writeFileSync(join(repo,'base.txt'),'base'); git('add','-A'); git('commit','-qm','base');
  const workdir=join(dir,'wt'); git('worktree','add','-q','-b','herdr/t',workdir);
  writeFileSync(join(workdir,'result.txt'),'result');
  const run=(args:string[],cwd=workdir)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@x',...args],{cwd,stdio:'ignore'});
  run(['add','-A']);run(['commit','-qm','work']);
  const ledger=new Ledger(join(dir,'ledger.sqlite'));ledger.add({repo,title:'test',why:'reason',brief:'handoff/t.md',check:'test -f result.txt'});ledger.setStatus('repo-1','走行中','start',{attempts:1});ledger.setRunner('repo-1',{workdir});ledger.setStatus('repo-1','確かめ中','worker done');
  const cleanup=()=>{ ledger.close(); rmSync(dir,{recursive:true,force:true}); delete process.env.TASK_LEDGER_DB; };
  return {dir,repo,workdir,ledger,cleanup};
}
function deps(answer:string,calls:string[]):AdvanceDeps { return {
  sh:(command,cwd,timeout)=>{calls.push(command);return command.includes('--cleanup')?{code:0,output:''}:realAdvanceDeps.sh(command,cwd,timeout)},
  review:(prompt)=>{calls.push(prompt);return answer},resend:()=>1234,pause:()=>{},
};}
const finding=(text:string,likelihood:string,harm:string,blocking:boolean)=>({text,likelihood,harm,blocking});

const severityCases=[
  {name:'small-only',f:[finding('style','いつも','小',true)],verdict:'直す',status:'済',sendback:false},
  {name:'major-only-isolated',f:[finding('major bug','まれ','大',false),finding('minor style','いつも','小',true)],verdict:'通す',status:'走行中',sendback:true},
  {name:'medium-always',f:[finding('slow every time','いつも','中',false)],verdict:'通す',status:'走行中',sendback:true},
  {name:'medium-sometimes',f:[finding('slow in condition','ときどき','中',true)],verdict:'直す',status:'済',sendback:false},
 ];
for(const item of severityCases)test(`severity ${item.name}: recalculates blocking from harm and likelihood`,()=>{const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'終わりの条件: 満たした\n');const calls:string[]=[];const answer=JSON.stringify({verdict:item.verdict,reasons:['review summary'],fixes:['do not use this'],findings:item.f});advance(f.ledger,'repo-1',deps(answer,calls),1);assert.equal(f.ledger.get('repo-1')!.status,item.status,item.name);if(item.sendback){const event=f.ledger.events('repo-1').at(-1)!;assert.match(event.note??'',/止めた指摘数: 1/);const details=readFileSync(join(f.dir,'logs/repo-1-sendback-1.log'),'utf8');assert.match(details,new RegExp(item.f[0]!.text));assert.doesNotMatch(details,/minor style|do not use this/);}else assert.match(f.ledger.events('repo-1').find(e=>e.to_status==='済')?.note??'',/残りにした指摘:/);}finally{f.cleanup();}});

test('no-findings legacy answer keeps its old verdict behavior; malformed structured findings are rejected',()=>{
 assert.equal(parseVerdict('{"verdict":"直す","reasons":["x"],"fixes":["y"]}')?.verdict,'直す');
 assert.equal(parseVerdict('{"verdict":"通す","reasons":[],"fixes":[],"findings":[{"text":"x","likelihood":"often","harm":"大","blocking":false}]}'),null);
 const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'終わりの条件: 満たした\n');const calls:string[]=[];advance(f.ledger,'repo-1',deps('{"verdict":"直す","reasons":["legacy"],"fixes":["legacy fix"]}',calls),1);assert.equal(f.ledger.get('repo-1')!.status,'走行中');assert.match(f.ledger.events('repo-1').at(-1)?.note??'',/legacy/);}finally{f.cleanup();}
});

test('remaining findings survive into task show and weekly finding metrics',()=>{
 const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'終わりの条件: 満たした\n');const calls:string[]=[];advance(f.ledger,'repo-1',deps(JSON.stringify({verdict:'直す',reasons:['review'],fixes:[],findings:[finding('one leftover','ときどき','小',false),finding('another leftover','まれ','中',false)]}),calls),1);const output:string[]=[];main(['show','repo-1'],x=>output.push(x));assert.match(output.join('\n'),/残りにした指摘: \["one leftover","another leftover"\]/);const result=metrics(f.ledger,{weeks:4,now:Date.now()+1000});const week=result.weeks.find(w=>w.repo===f.repo)!;assert.equal(week.remainingFindings,2);assert.equal(week.stoppedFindings,0);}finally{f.cleanup();}
});

test('weekly stopped findings metric counts only actually blocking findings',()=>{
 const f=fixture();try{writeFileSync(join(f.workdir,'handoff/t-report.md'),'終わりの条件: 満たした\n');const calls:string[]=[];advance(f.ledger,'repo-1',deps(JSON.stringify({verdict:'通す',reasons:[],fixes:[],findings:[finding('block','まれ','大',false),finding('remain','いつも','小',true)]}),calls),1);const result=metrics(f.ledger,{weeks:4,now:Date.now()+1000});const week=result.weeks.find(w=>w.repo===f.repo)!;assert.equal(week.stoppedFindings,1);assert.equal(week.remainingFindings,0);const rendered:string[]=[];main(['metrics','--repo',f.repo,'--weeks','4'],x=>rendered.push(x));assert.match(rendered[0]!,/止めた指摘\t残りにした指摘/);assert.match(rendered[1]!,/\t1\t0\t/);}finally{f.cleanup();}
});
