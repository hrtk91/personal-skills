if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,readFileSync,existsSync,copyFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Ledger} from './ledger.ts';
import {createDecisionCard,parseDecision,refreshDecisionCards} from './decision/index.ts';
import {main} from './cli.ts';
const good=JSON.stringify({situation:'目的と停止状況。',options:[{label:'続ける',detail:'もう一度進めます。',recommended:true,to:'待ち',answer:'対応を続ける'},{label:'やめる',detail:'仕事を終了します。',to:'やめ',answer:'終了'}]});

test('entering 判断待ち spawns one detached decision refresh, including under node:test',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-spawn-')),oldSpawn=process.env.TASK_BIN;
 const calls=join(dir,'calls'),fake=join(dir,'fake-spawn');
 writeFileSync(fake,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);chmodSync(fake,0o755);
 const ledger=new Ledger(join(dir,'db.sqlite'));
 try {
  process.env.TASK_BIN=fake;
  const task=ledger.add({repo:dir,title:'spawn test',why:'verify detached refresh',brief:'brief.md'});
  ledger.setStatus(task.id,'判断待ち','needs a decision');
  for(let i=0;i<100&&!existsSync(calls);i++) await delay(20);
  assert.equal(readFileSync(calls,'utf8').trim(),`decision refresh ${task.id}`);
  await delay(80);
  assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1);
  assert.equal(ledger.get(task.id)?.status,'判断待ち');
 } finally {ledger.close();if(oldSpawn===undefined)delete process.env.TASK_BIN;else process.env.TASK_BIN=oldSpawn;rmSync(dir,{recursive:true,force:true});}
});

test('TASK_BIN is used from a relocated ledger bundle, and a missing command reports one stderr line without blocking status',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-relocated-')),bundle=join(dir,'bundle'),decision=join(bundle,'decision'),oldBin=process.env.TASK_BIN;
 mkdirSync(decision,{recursive:true});
 copyFileSync(new URL('./ledger.ts',import.meta.url),join(bundle,'ledger.ts'));
 copyFileSync(new URL('./decision/index.ts',import.meta.url),join(decision,'index.ts'));
 copyFileSync(new URL('./decision/decision-prompt.md',import.meta.url),join(decision,'decision-prompt.md'));
 const called=join(dir,'called'),fake=join(dir,'fake-task');
 writeFileSync(fake,`#!/bin/sh\nprintf '%s\\n' "$*" > '${called}'\n`);chmodSync(fake,0o755);
 const relocated=await import(`${pathToFileURL(join(bundle,'ledger.ts')).href}?relocated=${Date.now()}`) as typeof import('./ledger.ts');
 const ledger=new relocated.Ledger(join(dir,'db.sqlite'));
 try {
  process.env.TASK_BIN=fake;
  const task=ledger.add({repo:dir,title:'relocated',why:'verify TASK_BIN',brief:'brief'});
  ledger.setStatus(task.id,'判断待ち','blocked');
  for(let i=0;i<100&&!existsSync(called);i++) await delay(20);
  assert.equal(readFileSync(called,'utf8').trim(),`decision refresh ${task.id}`);
  const missing=join(dir,'missing-task');
  const probe=`process.env.TASK_BIN=${JSON.stringify(missing)};const {Ledger}=await import(${JSON.stringify(pathToFileURL(join(bundle,'ledger.ts')).href)});const l=new Ledger(${JSON.stringify(join(dir,'probe.sqlite'))});const t=l.add({repo:'/tmp',title:'probe',why:'probe',brief:'x'});l.setStatus(t.id,'判断待ち','blocked');await new Promise(r=>setTimeout(r,60));l.close();`;
  const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--input-type=module','-e',probe],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stderr.trim().split('\n').length,1);assert.match(result.stderr,/task decision refresh 起動失敗/);
  assert.equal(ledger.get(task.id)?.status,'判断待ち');
 } finally {ledger.close();if(oldBin===undefined)delete process.env.TASK_BIN;else process.env.TASK_BIN=oldBin;rmSync(dir,{recursive:true,force:true});}
});

test('explicit TASK_BIN refresh child receives the open temporary ledger path',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-ledger-env-')),db=join(dir,'ledger.sqlite'),oldBin=process.env.TASK_BIN,oldDb=process.env.TASK_LEDGER_DB,oldClaude=process.env.TASK_CLAUDE_BIN;
 const received=join(dir,'received-ledger');const claude=join(dir,'claude');writeFileSync(claude,`#!/bin/sh\nprintf '%s' "$TASK_LEDGER_DB" > '${received}'\ncat '${join(dir,'response')}'\n`);chmodSync(claude,0o755);writeFileSync(join(dir,'response'),good);
 const ledger=new Ledger(db);
 try {
  process.env.TASK_BIN=join(import.meta.dirname,'bin/task');process.env.TASK_LEDGER_DB=join(dir,'wrong-parent-default.sqlite');process.env.TASK_CLAUDE_BIN=claude;
  const task=ledger.add({repo:dir,title:'isolated ledger',why:'verify child ledger propagation',brief:'brief.md'});
  ledger.setStatus(task.id,'判断待ち','blocked');
  let card=null;
  for(let i=0;i<250&&!card;i++){await delay(20);card=ledger.decisionCard(task.id,ledger.events(task.id).at(-1)!.at);}
  assert.ok(card,'actual task CLI child should refresh the card');
  assert.equal(process.env.TASK_LEDGER_DB,join(dir,'wrong-parent-default.sqlite'));
  assert.equal(ledger.path,db);
  assert.equal(readFileSync(received,'utf8'),db);
  assert.equal(ledger.decisionCard(task.id,ledger.events(task.id).at(-1)!.at)?.json.situation,'目的と停止状況。');
 } finally {ledger.close();if(oldBin===undefined)delete process.env.TASK_BIN;else process.env.TASK_BIN=oldBin;if(oldDb===undefined)delete process.env.TASK_LEDGER_DB;else process.env.TASK_LEDGER_DB=oldDb;if(oldClaude===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldClaude;rmSync(dir,{recursive:true,force:true});}
});

test('NODE_TEST_CONTEXT never starts the default task child when TASK_BIN is unset',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-test-safe-')),bundle=join(dir,'bundle'),binDir=join(bundle,'bin'),marker=join(dir,'spawned');mkdirSync(binDir,{recursive:true});
 copyFileSync(new URL('./ledger.ts',import.meta.url),join(bundle,'ledger.ts'));
 mkdirSync(join(bundle,'decision'),{recursive:true});copyFileSync(new URL('./decision/index.ts',import.meta.url),join(bundle,'decision/index.ts'));
 const fake=join(binDir,'task');writeFileSync(fake,`#!/bin/sh\nprintf spawned > '${marker}'\n`);chmodSync(fake,0o755);
 const script=`process.env.NODE_TEST_CONTEXT='test';delete process.env.TASK_BIN;const {Ledger}=await import(${JSON.stringify(pathToFileURL(join(bundle,'ledger.ts')).href)});const l=new Ledger(${JSON.stringify(join(dir,'db.sqlite'))});const t=l.add({repo:'/tmp',title:'safe test',why:'no default child',brief:'x'});l.setStatus(t.id,'判断待ち','blocked');await new Promise(r=>setTimeout(r,150));l.close();`;
 try {const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--input-type=module','-e',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(existsSync(marker),false);}
 finally {rmSync(dir,{recursive:true,force:true});}
});

test('an in-memory ledger never starts a decision refresh child',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-memory-')),oldBin=process.env.TASK_BIN,oldDb=process.env.TASK_LEDGER_DB;
 const called=join(dir,'called'),fake=join(dir,'fake-task');writeFileSync(fake,`#!/bin/sh\nprintf called > '${called}'\n`);chmodSync(fake,0o755);
 const ledger=new Ledger(':memory:');
 try {
  process.env.TASK_BIN=fake;process.env.TASK_LEDGER_DB=join(dir,'safe.sqlite');const task=ledger.add({repo:dir,title:'memory',why:'no child for memory',brief:'brief'});
  ledger.setStatus(task.id,'判断待ち','blocked');await delay(100);assert.equal(existsSync(called),false);assert.equal(ledger.get(task.id)?.status,'判断待ち');
 } finally {ledger.close();if(oldBin===undefined)delete process.env.TASK_BIN;else process.env.TASK_BIN=oldBin;if(oldDb===undefined)delete process.env.TASK_LEDGER_DB;else process.env.TASK_LEDGER_DB=oldDb;rmSync(dir,{recursive:true,force:true});}
});

test('a card immediately following review resumes that session as a fork, with only a card prompt',()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-fork-')),oldBin=process.env.TASK_CLAUDE_BIN,db=join(dir,'db.sqlite'),capture=join(dir,'capture'),bin=join(dir,'claude');
 writeFileSync(bin,`#!/bin/sh\nprintf '%s\\n' "$*" > '${capture}.args'\ncat > '${capture}.input'\nprintf '%s' '${good.replaceAll("'", "'\\''")}'\n`);chmodSync(bin,0o755);
 const ledger=new Ledger(db);
 try {process.env.TASK_CLAUDE_BIN=bin;const task=ledger.add({repo:dir,title:'fork',why:'secret detailed why',brief:'brief.md'});ledger.setRunner(task.id,{workdir:dir});ledger.saveClaudeSession(task.id,'review','review-session',dir,'head');ledger.setStatus(task.id,'レビュー中','reviewing');ledger.setStatus(task.id,'判断待ち','review held');const event=ledger.events(task.id).at(-1)!;
  assert.ok(createDecisionCard(ledger,ledger.get(task.id)!,event.at,'review held'));assert.match(readFileSync(capture+'.args','utf8'),/--resume review-session --fork-session/);assert.match(readFileSync(capture+'.args','utf8'),/--tools\s+--resume review-session --fork-session/);const input=readFileSync(capture+'.input','utf8');assert.match(input,/判断カードだけ/);assert.doesNotMatch(input,/secret detailed why/);
 } finally {ledger.close();if(oldBin===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldBin;rmSync(dir,{recursive:true,force:true});}
});

test('decision cards not immediately caused by review do not fork',()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-no-fork-')),oldBin=process.env.TASK_CLAUDE_BIN,capture=join(dir,'args'),bin=join(dir,'claude');writeFileSync(bin,`#!/bin/sh\nprintf '%s' "$*" > '${capture}'\ncat >/dev/null\nprintf '%s' '${good.replaceAll("'", "'\\''")}'\n`);chmodSync(bin,0o755);const ledger=new Ledger(join(dir,'db.sqlite'));
 try{process.env.TASK_CLAUDE_BIN=bin;const task=ledger.add({repo:dir,title:'fresh',why:'why',brief:'brief.md'});ledger.saveClaudeSession(task.id,'review','review-session',dir,null);ledger.setStatus(task.id,'判断待ち','not from review');createDecisionCard(ledger,ledger.get(task.id)!,ledger.events(task.id).at(-1)!.at,'blocked');assert.doesNotMatch(readFileSync(capture,'utf8'),/--fork-session|--resume/);}
 finally{ledger.close();if(oldBin===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=oldBin;rmSync(dir,{recursive:true,force:true});}
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
