import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from './ledger.ts';
import { classify, metrics } from './metrics.ts';
import { advance, type AdvanceDeps } from './advance.ts';

test('classifies recorded event wording and measures first pass despite ordinary running transition', () => {
 const cases:[string,string|null,string,string][]=[
  ['差し戻し: 確かめのコマンド `npm test` が落ちた。','確かめ中','走行中','作業役の検査が落ちた'],
  ['レビューで直すことになった。直す。','レビュー中','走行中','レビューの差し戻し'],
  ['本体との衝突の印を解消してください。','取り込み中','判断待ち','本体との食い違い'],
  ['作業役の報告が、終わりの条件を満たしていないと書いている','レビュー中','走行中','作業役の自己申告（未完了）'],
  ['作業役を回す台本が失敗した','走行中','判断待ち','台本・環境の失敗'],
  ['先に済むはずの「x」が止まった','待ち','判断待ち','前の仕事待ちで止まった'],
  ['本体に入れたあとの確かめが落ちたので戻した','取り込み中','判断待ち','取り込み後の検査が落ちた'],
  ['取り込んだが、本番に出せなかった。','取り込み中','判断待ち','本番に出せなかった'],
 ];
 for(const [note,from_status,to_status,want] of cases)assert.equal(classify({note,from_status,to_status}),want);
 const dir=mkdtempSync(join('/tmp','task-metrics-'));const path=join(dir,'db.sqlite');let clock=Date.parse('2026-10-26T00:00:00Z');const l=new Ledger(path,()=>new Date(clock));
 try {
  const task=l.add({repo:'/repo',title:'test',why:'reason',brief:'brief'});l.setStatus(task.id,'走行中','first run',{attempts:1});clock+=3600_000;l.setStatus(task.id,'確かめ中','check');clock+=3600_000;l.setStatus(task.id,'走行中','差し戻し: 確かめのコマンド failed',{attempts:2});clock+=3600_000;l.setStatus(task.id,'済','done');
  const clean=l.add({repo:'/repo',title:'clean',why:'reason',brief:'brief'});l.setStatus(clean.id,'走行中','first run',{attempts:1});clock+=1000;l.setStatus(clean.id,'済','done');
  const result=metrics(l,{repo:'/repo',weeks:4,now:Date.parse('2026-10-27T12:00:00Z')});assert.equal(result.weeks.length,1);assert.equal(result.weeks[0]!.completed,2);assert.equal(result.weeks[0]!.firstPass,1);assert.equal(result.weeks[0]!.failures['作業役の検査が落ちた'],1);assert.deepEqual(result.weeks[0]!.frequentTitles,[{kind:'作業役の検査が落ちた',title:'test',count:1}]);
 } finally {l.close();rmSync(dir,{recursive:true,force:true});}
});

test('review send-back stores reviewer kinds in the resulting event', async () => {
 const dir=mkdtempSync(join('/tmp','task-metrics-review-'));const repo=join(dir,'repo');const l=new Ledger(join(dir,'db.sqlite'));const task=l.add({repo,title:'reviewed',why:'reason',brief:'handoff/x.md'});l.setStatus(task.id,'走行中','start',{attempts:1});l.setStatus(task.id,'レビュー中','checked');l.setRunner(task.id,{workdir:dir});
 const deps:AdvanceDeps={sh:()=>({code:0,output:'HEAD'}),review:()=>'{"verdict":"通す","reasons":[],"fixes":[],"kinds":["実装の誤り"],"findings":[{"text":"修正","likelihood":"いつも","harm":"大","blocking":true}]}',resend:()=>44,pause:()=>{}};
 try{advance(l,task.id,deps);assert.equal(l.events(task.id).at(-1)?.kind,'実装の誤り');}finally{l.close();rmSync(dir,{recursive:true,force:true});}
});

test('a review decision send-back also stores reviewer kinds in the resulting event', () => {
 const dir=mkdtempSync(join('/tmp','task-metrics-decision-'));const repo=join(dir,'repo');const l=new Ledger(join(dir,'db.sqlite'));const task=l.add({repo,title:'decision',why:'reason',brief:'handoff/x.md'});l.setStatus(task.id,'走行中','start',{attempts:1});l.setStatus(task.id,'レビュー中','checked');l.setRunner(task.id,{workdir:dir});
 const deps:AdvanceDeps={sh:()=>({code:0,output:'HEAD'}),review:()=>'{"verdict":"判断","reasons":["確認が必要"],"fixes":[],"kinds":["依頼文の食い違い"]}',resend:()=>44,pause:()=>{}};
 try{advance(l,task.id,deps);assert.equal(l.get(task.id)?.status,'判断待ち');assert.equal(l.events(task.id).at(-1)?.kind,'依頼文の食い違い');}finally{l.close();rmSync(dir,{recursive:true,force:true});}
});

test('backfill uses replaceable fake claude and normalizes an unknown category', async () => {
 const dir=mkdtempSync(join('/tmp','task-metrics-backfill-'));const db=join(dir,'db.sqlite');const l=new Ledger(db);const task=l.add({repo:dir,title:'reviewed',why:'reason',brief:'brief'});l.setStatus(task.id,'走行中','start',{attempts:1});l.setStatus(task.id,'レビュー中','check');l.setStatus(task.id,'走行中','差し戻し: レビューで直すことになった。');const at=l.events(task.id).at(-1)!.at;l.close();
 const fake=join(dir,'claude');writeFileSync(fake,`#!/bin/sh\nprintf '%s' '${JSON.stringify([{task_id:task.id,at,kinds:['未知の語']}])}'\n`);chmodSync(fake,0o755);process.env.TASK_LEDGER_DB=db;process.env.TASK_CLAUDE_BIN=fake;
 try{const {main}=await import('./cli.ts');const output:string[]=[];assert.equal(main(['metrics','backfill-review-kinds'],x=>output.push(x)),0);const check=new Ledger(db);try{assert.equal(check.events(task.id).at(-1)?.kind,'その他');}finally{check.close();}}finally{delete process.env.TASK_LEDGER_DB;delete process.env.TASK_CLAUDE_BIN;rmSync(dir,{recursive:true,force:true});}
});

test('backfill skips a timed-out batch and reports the skipped count', async () => {
 const dir=mkdtempSync(join('/tmp','task-metrics-timeout-'));const db=join(dir,'db.sqlite');const l=new Ledger(db);const task=l.add({repo:dir,title:'slow review',why:'reason',brief:'brief'});l.setStatus(task.id,'走行中','start',{attempts:1});l.setStatus(task.id,'レビュー中','check');l.setStatus(task.id,'走行中','差し戻し: レビューで直すことになった。');l.close();
 const fake=join(dir,'claude');writeFileSync(fake,'#!/bin/sh\nsleep 2\n');chmodSync(fake,0o755);process.env.TASK_LEDGER_DB=db;process.env.TASK_CLAUDE_BIN=fake;process.env.TASK_METRICS_TIMEOUT_MS='50';
 try{const {main}=await import('./cli.ts');const output:string[]=[];assert.equal(main(['metrics','backfill-review-kinds'],x=>output.push(x)),0);assert.match(output.join(' '),/時間切れで飛ばした 1 件/);const check=new Ledger(db);try{assert.equal(check.events(task.id).at(-1)?.kind,null);}finally{check.close();}}finally{delete process.env.TASK_LEDGER_DB;delete process.env.TASK_CLAUDE_BIN;delete process.env.TASK_METRICS_TIMEOUT_MS;rmSync(dir,{recursive:true,force:true});}
});

test('events kind column is added to an existing ledger schema', () => {
 const dir=mkdtempSync(join('/tmp','task-metrics-migrate-'));const path=join(dir,'db.sqlite');const db=new DatabaseSync(path);db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,repo TEXT NOT NULL,title TEXT NOT NULL,why TEXT NOT NULL,brief TEXT,\"check\" TEXT,after_json TEXT NOT NULL DEFAULT '[]',files_json TEXT NOT NULL DEFAULT '[]',kind TEXT NOT NULL DEFAULT '処理',deploy INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,note TEXT,attempts INTEGER NOT NULL DEFAULT 0,agent TEXT,\"commit\" TEXT,runner INTEGER,workdir TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,issue_id TEXT,priority REAL NOT NULL DEFAULT 0,worker TEXT,model TEXT,effort TEXT) STRICT; CREATE TABLE events(task_id TEXT NOT NULL,at TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,note TEXT) STRICT;");db.close();
 const ledger=new Ledger(path);try{assert.ok((ledger.db.prepare('PRAGMA table_info(events)').all() as {name:string}[]).some(c=>c.name==='kind'));}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
