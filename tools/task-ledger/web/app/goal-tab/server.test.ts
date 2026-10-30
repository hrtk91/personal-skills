if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../../ledger.ts';
import { claudeUsageLoadingForTest, claudeUsageReadCountForTest, expireClaudeUsageCacheForTest, loadGoalData, resetClaudeUsageForTest, submitIntent } from './server.ts';

function setupClaudeUsageEnv(prefix:string) {
 const dir=mkdtempSync(join(tmpdir(),prefix));
 process.env.CLAUDE_PROJECTS_DIR=join(dir,'claude-projects');
 process.env.CLAUDE_USAGE_DIR=join(dir,'claude-usage');
 mkdirSync(process.env.CLAUDE_PROJECTS_DIR,{recursive:true});
 return dir;
}

test('loader emits decisions, ready queue, goal stages and recent rows; actions mutate a temporary ledger',async()=>{
 const dir=setupClaudeUsageEnv('goal-tab-');const l=new Ledger(join(dir,'db.sqlite'));resetClaudeUsageForTest();
 try {
  const projectDir=join(process.env.CLAUDE_PROJECTS_DIR!,'large');mkdirSync(projectDir,{recursive:true});
  const transcript=join(projectDir,'large.jsonl'), timestamp=new Date().toISOString();
  const lines=Array.from({length:12000},(_,i)=>JSON.stringify({type:'assistant',timestamp,requestId:`req-${i}`,cwd:'/tmp/example-project',entrypoint:'cli',message:{id:`msg-${i}`,model:'claude-sonnet',usage:{input_tokens:100,cache_read_input_tokens:10,cache_creation_input_tokens:5,output_tokens:20}}}));
  writeFileSync(transcript,lines.join('\n')+'\n');
  const usageDir=process.env.CLAUDE_USAGE_DIR!;mkdirSync(usageDir,{recursive:true});const observed=new Date(), reset=Math.floor((observed.getTime()+86400000)/1000);
  writeFileSync(join(usageDir,'limits.jsonl'),[{at:new Date(observed.getTime()-7200000).toISOString(),seven_day:20,seven_day_resets_at:reset,five_hour:30,five_hour_resets_at:reset},{at:observed.toISOString(),seven_day:30,five_hour:40,seven_day_resets_at:reset,five_hour_resets_at:reset}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const repo='/tmp/example-project';const goal=l.addGoal({repo,title:'Ship it',stages:['Build','Ship']});
  const issue=l.addIssue({repo,title:'Build thing',goal_id:goal.id,stage:'Build',by:'Claude'});
  const decision=l.add({repo,title:'Need decision',why:'test',brief:'brief',issue_id:issue.id});l.setStatus(decision.id,'判断待ち','Need approval');
  l.db.prepare('INSERT INTO decision_cards(task_id,entered_at,json,model,created_at) VALUES(?,?,?,?,?)').run(decision.id,l.events(decision.id).at(-1)!.at,JSON.stringify({situation:'背景と停止理由。',options:[{label:'続行',detail:'作業を再開します。',recommended:true,to:'待ち',answer:'続ける'},{label:'やめる',detail:'仕事を終了します。',to:'やめ',answer:'終了'}]}),'test','now');
  const ready=l.add({repo,title:'Queued item',why:'test',brief:'brief',files:['queued.ts']});
  const run=l.add({repo,title:'Running item',why:'test',brief:'brief',files:['running.ts']});l.setStatus(run.id,'走行中');
  const done=l.add({repo,title:'Recent item',why:'test',brief:'brief'});l.setStatus(done.id,'済');
  const first=loadGoalData(l,repo,new Date(Date.now()+1000));
  const concurrent=loadGoalData(l,repo,new Date(Date.now()+1000));
  assert.deepEqual(first.claudeUsage,{pending:true});assert.deepEqual(concurrent.claudeUsage,{pending:true});
  let timerFired=false;await new Promise<void>(resolve=>setTimeout(()=>{timerFired=true;resolve();},0));assert.equal(timerFired,true);assert.equal(claudeUsageReadCountForTest(),1);
  let data=first;
  for(let i=0;i<100&&data.claudeUsage.pending;i++){await new Promise(resolve=>setTimeout(resolve,10));data=loadGoalData(l,repo,new Date(Date.now()+1000));}
  assert.equal(data.claudeUsage.pending,undefined);
  assert.ok((data.claudeUsage.readMs??-1)>=0);assert.equal(claudeUsageReadCountForTest(),1);
  assert.equal(data.claudeUsage.pace?.hours,2);assert.equal(data.claudeUsage.today?.byCaller.length,1);assert.equal(data.claudeUsage.today?.byCallerReason.length,1);assert.equal(data.claudeUsage.week?.byCaller.length,1);assert.equal(data.claudeUsage.week?.byCallerReason.length,1);
  const usageJson=JSON.stringify(data.claudeUsage);
  assert.equal(usageJson.includes('events'),false);assert.ok(Buffer.byteLength(usageJson)<50*1024);
  assert.deepEqual(loadGoalData(l,repo,new Date(Date.now()+1000)).claudeUsage,data.claudeUsage);
  expireClaudeUsageCacheForTest();assert.deepEqual(loadGoalData(l,repo,new Date(Date.now()+1000)).claudeUsage,data.claudeUsage);assert.equal(claudeUsageReadCountForTest(),2);for(let i=0;i<100&&claudeUsageLoadingForTest();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(claudeUsageLoadingForTest(),false);
  assert.equal(data.decisions[0].question,'背景と停止理由。');assert.equal(data.decisions[0].situation,'背景と停止理由。');assert.equal(data.decisions[0].options?.[0].to,'待ち');assert.equal(data.decisions[0].options?.[0].answer,'続ける');assert.equal(data.queue[0].id,run.id);assert(data.queue.some(q=>q.id===ready.id&&q.movable));
  assert.equal(data.goals[0].stages[0].state,'stuck');assert(data.recent.some(r=>r.id===done.id));
  submitIntent(l,repo,{intent:'answer',taskId:decision.id,text:'approve'});assert.equal(l.get(decision.id)?.status,'待ち');
  const mapped=l.add({repo,title:'Mapped option',why:'test',brief:'brief'});l.setStatus(mapped.id,'判断待ち','Choose');const entered=l.events(mapped.id).at(-1)!.at;l.db.prepare('INSERT INTO decision_cards(task_id,entered_at,json,model,created_at) VALUES(?,?,?,?,?)').run(mapped.id,entered,JSON.stringify({situation:'Situation',options:[{label:'Stop',detail:'Stop task',recommended:true,to:'やめ',answer:'stop task now'},{label:'Wait',detail:'Wait',to:'待ち',answer:'continue later'}]}),'test','now');submitIntent(l,repo,{intent:'answer',taskId:mapped.id,text:'Stop'});assert.equal(l.get(mapped.id)?.status,'やめ');assert.match(l.get(mapped.id)?.note??'',/stop task now/);
  const merge=l.add({repo,title:'Import option',why:'test',brief:'brief'});l.setStatus(merge.id,'判断待ち','Choose');l.setRunner(merge.id,{workdir:dir});const mergeAt=l.events(merge.id).at(-1)!.at;l.db.prepare('INSERT INTO decision_cards(task_id,entered_at,json,model,created_at) VALUES(?,?,?,?,?)').run(merge.id,mergeAt,JSON.stringify({situation:'Situation',options:[{label:'取り込む',detail:'取り込みに進みます。',recommended:true,to:'取り込み中',answer:'レビューを越えて取り込む。'} ,{label:'保留',detail:'後で決めます。',to:'保留',answer:'保留する。'}]}),'test','now');const oldTaskBin=process.env.TASK_BIN,invocations=join(dir,'task-bin-calls'),receivedDb=join(dir,'received-db'),fakeTaskBin=join(dir,'fake-task-bin');writeFileSync(fakeTaskBin,`#!/bin/sh\nif [ "$1" = advance ]; then printf '%s\\n' "$*" >> ${JSON.stringify(invocations)}; printf '%s' "$TASK_LEDGER_DB" > ${JSON.stringify(receivedDb)}; fi\n`);chmodSync(fakeTaskBin,0o755);process.env.TASK_BIN=fakeTaskBin;try{const response=submitIntent(l,repo,{intent:'answer',taskId:merge.id,text:'取り込む'});assert.deepEqual(response,{ok:true});assert.equal(l.get(merge.id)?.status,'取り込み中');assert.match(l.get(merge.id)?.note??'',/レビューを越えて取り込む/);for(let i=0;i<100&&!existsSync(invocations);i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(readFileSync(invocations,'utf8'),`advance ${merge.id}\n`);assert.equal(readFileSync(receivedDb,'utf8'),l.path);const waitTask=l.add({repo,title:'Wait answer',why:'test',brief:'brief'});l.setStatus(waitTask.id,'判断待ち','Choose');submitIntent(l,repo,{intent:'answer',taskId:waitTask.id,text:'later',to:'待ち'});assert.equal(readFileSync(invocations,'utf8'),`advance ${merge.id}\n`);const broken=l.add({repo,title:'Missing task bin',why:'test',brief:'brief'});l.setRunner(broken.id,{workdir:dir});l.setStatus(broken.id,'判断待ち','Choose');const brokenAt=l.events(broken.id).at(-1)!.at;l.db.prepare('INSERT INTO decision_cards(task_id,entered_at,json,model,created_at) VALUES(?,?,?,?,?)').run(broken.id,brokenAt,JSON.stringify({situation:'Situation',options:[{label:'取り込む',detail:'取り込む',recommended:true,to:'取り込み中',answer:'import'},{label:'保留',detail:'保留',to:'保留',answer:'hold'}]}),'test','now');process.env.TASK_BIN=join(dir,'does-not-exist');assert.doesNotThrow(()=>submitIntent(l,repo,{intent:'answer',taskId:broken.id,text:'取り込む'}));await new Promise(resolve=>setTimeout(resolve,50));}finally{if(oldTaskBin===undefined)delete process.env.TASK_BIN;else process.env.TASK_BIN=oldTaskBin;}
  submitIntent(l,repo,{intent:'move-task',taskId:ready.id,move:'first'});
  assert.throws(()=>submitIntent(l,repo,{intent:'move-task',taskId:run.id,move:'up'}), (e:any)=>e.status===400);
  submitIntent(l,repo,{intent:'move-goal',goalId:goal.id,move:'up'});
  submitIntent(l,repo,{intent:'create-goal',title:'New goal',why:'why'});assert.equal(l.listGoals(repo).length,2);
 } finally {l.close();rmSync(dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('usage scan errors are reported and returned instead of remaining pending',async()=>{
 const dir=setupClaudeUsageEnv('goal-tab-error-');const l=new Ledger(join(dir,'db.sqlite'));resetClaudeUsageForTest();
 try {
  const repo='/tmp/usage-error';l.add({repo,title:'error target',why:'test',brief:'test'});
  const blocker=join(dir,'usage-blocker');writeFileSync(blocker,'not a directory');process.env.CLAUDE_USAGE_DIR=blocker;
  mkdirSync(join(process.env.CLAUDE_PROJECTS_DIR!,'p'),{recursive:true});writeFileSync(join(process.env.CLAUDE_PROJECTS_DIR!,'p','one.jsonl'),JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),requestId:'failure',message:{usage:{input_tokens:1}}})+'\n');
  const oldError=console.error;let logged=false;console.error=()=>{logged=true;};
  try {
   loadGoalData(l,repo);
   let result=loadGoalData(l,repo).claudeUsage;
   for(let i=0;i<100&&result.pending;i++){await new Promise(resolve=>setTimeout(resolve,10));result=loadGoalData(l,repo).claudeUsage;}
   assert.equal(typeof result.error,'string');assert.equal(result.pending,undefined);assert.equal(logged,true);assert.equal(claudeUsageReadCountForTest(),1);
  } finally {console.error=oldError;}
 } finally {l.close();rmSync(dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('queue includes blocked waiting tasks with reasons after ready tasks',()=>{
 const dir=setupClaudeUsageEnv('goal-tab-blocked-');const l=new Ledger(join(dir,'db.sqlite'));
 try {
  const repo='/tmp/blocked-project';
  const active=l.add({repo,title:'Active overlap blocker',why:'test',brief:'brief',files:['shared.ts']});l.setStatus(active.id,'走行中');
  const ready=l.add({repo,title:'Ready task',why:'test',brief:'brief',files:['free.ts']});
  const overlapA=l.add({repo,title:'Overlap A',why:'test',brief:'brief',files:['shared.ts']});
  const overlapB=l.add({repo,title:'Overlap B',why:'test',brief:'brief',files:['shared.ts']});
  const prerequisite=l.add({repo,title:'After prerequisite',why:'test',brief:'brief',files:['other.ts']});l.setStatus(prerequisite.id,'走行中');
  const after=l.add({repo,title:'After task',why:'test',brief:'brief',files:['after.ts'],after:[prerequisite.id]});
  const data=loadGoalData(l,repo);
  assert.deepEqual(data.queue.map(q=>q.id),[active.id,prerequisite.id,ready.id,overlapA.id,overlapB.id,after.id]);
  assert.equal(data.queue.find(q=>q.id===overlapA.id)?.blockedBy,`${active.id} が終わるのを待っています（触るファイルが重なるため）`);
  assert.equal(data.queue.find(q=>q.id===overlapB.id)?.blockedBy,`${active.id} が終わるのを待っています（触るファイルが重なるため）`);
  assert.equal(data.queue.find(q=>q.id===after.id)?.blockedBy,`${prerequisite.id} が終わるのを待っています`);
 } finally {l.close();rmSync(dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});
