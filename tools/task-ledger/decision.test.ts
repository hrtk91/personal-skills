if (process.env.TASK_DECISION_SPAWN === undefined) process.env.TASK_DECISION_SPAWN = "/bin/true";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Ledger} from './ledger.ts';
import {createDecisionCard,parseDecision,refreshDecisionCards} from './decision/index.ts';
import {main} from './cli.ts';
const good=JSON.stringify({situation:'目的と停止状況。',options:[{label:'続ける',detail:'もう一度進めます。',recommended:true,to:'待ち',answer:'対応を続ける'},{label:'やめる',detail:'仕事を終了します。',to:'やめ',answer:'終了'}]});

test('entering 判断待ち spawns one detached decision refresh, including under node:test',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-spawn-')),oldSpawn=process.env.TASK_DECISION_SPAWN;
 const calls=join(dir,'calls'),fake=join(dir,'fake-spawn');
 writeFileSync(fake,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);chmodSync(fake,0o755);
 const ledger=new Ledger(join(dir,'db.sqlite'));
 try {
  process.env.TASK_DECISION_SPAWN=fake;
  const task=ledger.add({repo:dir,title:'spawn test',why:'verify detached refresh',brief:'brief.md'});
  ledger.setStatus(task.id,'判断待ち','needs a decision');
  for(let i=0;i<100&&!existsSync(calls);i++) await delay(20);
  assert.equal(readFileSync(calls,'utf8').trim(),`decision refresh ${task.id}`);
  await delay(80);
  assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1);
  assert.equal(ledger.get(task.id)?.status,'判断待ち');
 } finally {ledger.close();if(oldSpawn===undefined)delete process.env.TASK_DECISION_SPAWN;else process.env.TASK_DECISION_SPAWN=oldSpawn;rmSync(dir,{recursive:true,force:true});}
});

test('decision card validates and retries invalid JSON exactly once; refresh creates card',()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-card-')),oldBin=process.env.TASK_CLAUDE_BIN,oldModel=process.env.TASK_DECISION_MODEL;
 const counter=join(dir,'count'),bin=join(dir,'claude');
 writeFileSync(bin,`#!/bin/sh\ncount=0; [ -f '${counter}' ] && count=$(cat '${counter}'); count=$((count+1)); echo $count > '${counter}'; if [ "$count" -eq 1 ]; then echo bad; else cat '${join(dir,'response')}'; fi\n`);chmodSync(bin,0o755);writeFileSync(join(dir,'response'),good);
 const ledger=new Ledger(join(dir,'db.sqlite'));
 try {process.env.TASK_CLAUDE_BIN=bin;process.env.TASK_DECISION_MODEL='test-model';const t=ledger.add({repo:dir,title:'test',why:'why',brief:'brief.md'});const entered='2025-01-01T00:00:00.000Z';
  const made=createDecisionCard(ledger,ledger.get(t.id)!,entered,'blocked');assert.deepEqual(made,JSON.parse(good));assert.equal(readFileSync(counter,'utf8').trim(),'2');assert.equal(ledger.decisionCard(t.id,entered)?.model,'test-model');
  const invalidBin=join(dir,'invalid');writeFileSync(invalidBin,'#!/bin/sh\necho invalid\n');chmodSync(invalidBin,0o755);process.env.TASK_CLAUDE_BIN=invalidBin;
  const other=ledger.add({repo:dir,title:'other',why:'why',brief:'brief.md'});assert.equal(createDecisionCard(ledger,ledger.get(other.id)!,entered,'bad'),null);assert.equal(parseDecision('not json'),null);
  process.env.TASK_CLAUDE_BIN=bin;ledger.setStatus(t.id,'判断待ち','blocked');assert.equal(refreshDecisionCards(ledger,t.id),1);
  const oldDb=process.env.TASK_LEDGER_DB;process.env.TASK_LEDGER_DB=join(dir,'db.sqlite');let output='';assert.equal(main(['decision','refresh',t.id],x=>output=x),0);assert.match(output,/1 件の判断カードを作り直した/);if(oldDb===undefined)delete process.env.TASK_LEDGER_DB;else process.env.TASK_LEDGER_DB=oldDb;
 } finally {ledger.close();if(oldBin===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldBin;if(oldModel===undefined)delete process.env.TASK_DECISION_MODEL;else process.env.TASK_DECISION_MODEL=oldModel;rmSync(dir,{recursive:true,force:true});}
});
