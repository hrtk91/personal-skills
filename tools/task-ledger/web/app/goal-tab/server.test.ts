import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../../ledger.ts';
import { loadGoalData,submitIntent } from './server.ts';

test('loader emits decisions, ready queue, goal stages and recent rows; actions mutate a temporary ledger',()=>{
 const dir=mkdtempSync(join(tmpdir(),'goal-tab-'));const l=new Ledger(join(dir,'db.sqlite'));
 try {
  const repo='/tmp/example-project';const goal=l.addGoal({repo,title:'Ship it',stages:['Build','Ship']});
  const issue=l.addIssue({repo,title:'Build thing',goal_id:goal.id,stage:'Build',by:'Claude'});
  const decision=l.add({repo,title:'Need decision',why:'test',brief:'brief',issue_id:issue.id});l.setStatus(decision.id,'判断待ち','Need approval');
  const ready=l.add({repo,title:'Queued item',why:'test',brief:'brief',files:['queued.ts']});
  const run=l.add({repo,title:'Running item',why:'test',brief:'brief',files:['running.ts']});l.setStatus(run.id,'走行中');
  const done=l.add({repo,title:'Recent item',why:'test',brief:'brief'});l.setStatus(done.id,'済');
  const data=loadGoalData(l,repo,new Date(Date.now()+1000));
  assert.equal(data.decisions[0].question,'Need approval');assert.equal(data.queue[0].id,run.id);assert(data.queue.some(q=>q.id===ready.id&&q.movable));
  assert.equal(data.goals[0].stages[0].state,'stuck');assert(data.recent.some(r=>r.id===done.id));
  submitIntent(l,repo,{intent:'answer',taskId:decision.id,text:'approve'});assert.equal(l.get(decision.id)?.status,'待ち');
  submitIntent(l,repo,{intent:'move-task',taskId:ready.id,move:'first'});
  assert.throws(()=>submitIntent(l,repo,{intent:'move-task',taskId:run.id,move:'up'}), (e:any)=>e.status===400);
  submitIntent(l,repo,{intent:'move-goal',goalId:goal.id,move:'up'});
  submitIntent(l,repo,{intent:'create-goal',title:'New goal',why:'why'});assert.equal(l.listGoals(repo).length,2);
 } finally {l.close();rmSync(dir,{recursive:true,force:true});}
});

test('queue includes blocked waiting tasks with reasons after ready tasks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'goal-tab-blocked-'));const l=new Ledger(join(dir,'db.sqlite'));
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
 } finally {l.close();rmSync(dir,{recursive:true,force:true});}
});
