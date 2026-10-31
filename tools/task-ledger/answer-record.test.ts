import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { answerTask } from './answer.ts';
import { parsePrinciples } from './principles.ts';
import { dailyAnswerCounts, goalTaskCounts, processAnswerFeedback } from './answer-data.ts';

test('principle parser supports numbered suffixes and value criteria',()=>{
 const result=parsePrinciples('# x\n## Rules\n1. **Title** body\nline\n7a. **Other**\n## 大事な価値基準\n3. **Value** body','共通');
 assert.deepEqual(result.map(x=>x.ref),['共通:1','共通:7a','価値基準3']); assert.equal(result[0]?.body,'body\nline');
});
test('answer transaction stores Claude answer and validated principle; missing and unknown refs reject',()=>{
 const home=mkdtempSync(join(tmpdir(),'answers-home-'));mkdirSync(join(home,'.claude/rules'),{recursive:true});writeFileSync(join(home,'.claude/rules/principles.md'),'## Rules\n1. **Keep records**\n');
 const old=process.env.HOME;process.env.HOME=home;
 const db=new Ledger(':memory:');try {
  const task=db.add({repo:home,title:'decision',why:'because'});db.setStatus(task.id,'判断待ち','question');
  assert.throws(()=>answerTask(db,task.id,'no principle'),/当てはまる原則が無いなら答えずに判断待ちのまま残す/);
  assert.throws(()=>answerTask(db,task.id,'answer','待ち',undefined,'Claude','共通:99'),/原則の参照がありません/);
  answerTask(db,task.id,'answer','待ち',undefined,'Claude','共通:1');
  const rows=db.db.prepare('SELECT by,text,to_status,principle,at FROM answers').all() as any[];assert.equal(rows.length,1);assert.equal(rows[0].by,'Claude');assert.equal(rows[0].principle,'共通:1');assert.equal(db.events(task.id).at(-1)?.at,rows[0].at);
 } finally {db.close();if(old===undefined)delete process.env.HOME;else process.env.HOME=old;rmSync(home,{recursive:true,force:true});}
});
test('feedback action records correction, and principle form actions change candidate status',()=>{
 const db=new Ledger(':memory:');try{const t=db.add({repo:'/repo',title:'x',why:'y'});db.setStatus(t.id,'判断待ち','q');const candidate=db.addPrincipleCandidate({target:'共通',text:'Rule',quote:'Evidence'});answerTask(db,t.id,'answer','待ち',undefined,'あなた',null);const at=(db.db.prepare('SELECT at FROM answers').get() as any).at;processAnswerFeedback(db,{taskId:t.id,answerAt:at,action:'違う',note:'not so'});assert.equal(db.listFeedback()[0]?.note,'not so');processAnswerFeedback(db,{taskId:t.id,answerAt:at,action:'直して入れる',candidateId:candidate,finalText:'Revised'});assert.equal(db.listPrincipleCandidates()[0]?.status,'直して入れる');assert.equal(db.listPrincipleCandidates()[0]?.final_text,'Revised');}finally{db.close();}
});
test('goal counts and daily answer aggregation are stable',()=>{
 const db=new Ledger(':memory:');try {const g=db.addGoal({repo:'/repo',title:'Epic'}),t=db.add({repo:'/repo',title:'x',why:'y'});db.setTaskGoal(t.id,g.id);assert.equal(goalTaskCounts(db).goals[0]?.total,1);assert.equal(goalTaskCounts(db).unassigned.length,0);assert.deepEqual(dailyAnswerCounts([{at:'2026-01-01T00:00Z',by:'Claude'},{at:'2026-01-01T01:00Z',by:'Claude'}]),[{day:'2026-01-01',by:'Claude',count:2}]);}finally{db.close();}
});
