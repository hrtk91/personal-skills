import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../../../ledger.ts';
import {loadConsultData,submitConsultIntent} from './server.ts';

const wait=async(fn:()=>boolean)=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,20));assert.ok(fn(),'timed out waiting for child process');};
test('相談の返答を 1 つの発言として保存し、再読込と決定を可能にする（偽 Claude）',async()=>{
 const root=mkdtempSync(join(tmpdir(),'task-consult-'));const db=join(root,'ledger.sqlite');const chat=join(root,'consult');const bin=join(root,'claude');const argv=join(root,'argv');
 writeFileSync(bin,`#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(argv)},process.argv.slice(2).join(' '));process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:'forked-review-session'}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'一行目\\n二行目'}]}}));console.log(JSON.stringify({type:'result',result:'一行目\\n二行目'}));});\n`);chmodSync(bin,0o755);
 const previous={TASK_LEDGER_CONSULT_DIR:process.env.TASK_LEDGER_CONSULT_DIR,TASK_CLAUDE_BIN:process.env.TASK_CLAUDE_BIN};process.env.TASK_LEDGER_CONSULT_DIR=chat;process.env.TASK_CLAUDE_BIN=bin;
 const ledger=new Ledger(db);try{const repo=root;const task=ledger.add({repo,title:'判断待ち相談',why:'テスト',brief:'相談テスト',worker:'claude'});ledger.setStatus(task.id,'判断待ち','どちらにするか');ledger.setSessionId(task.id,'review','review-session');ledger.setSessionId(task.id,'worker','worker-session');
  const first=loadConsultData(ledger,repo,task.id);assert.equal(first.partner,'review');assert.equal(first.partners.find(p=>p.kind==='review')?.sessionId,'review-session');
  submitConsultIntent(ledger,repo,{intent:'consult-send',taskId:task.id,partner:'review',model:'haiku',text:'一問'});await wait(()=>{const messages=loadConsultData(ledger,repo,task.id,'review').messages;return messages.some(m=>m.text.includes('二行目'))&&!messages.some(m=>m.pending);});
  const messages=loadConsultData(ledger,repo,task.id,'review').messages;assert.deepEqual(messages.map(m=>m.text),['一問','一行目\n二行目']);
  const args=readFileSync(argv,'utf8');assert.match(args,/--resume review-session/);assert.match(args,/--fork-session/);assert.match(args,/--model haiku/);assert.match(args,/--strict-mcp-config/);assert.equal(ledger.consultSessionId(task.id,'review'),'forked-review-session');
  submitConsultIntent(ledger,repo,{intent:'consult-send',taskId:task.id,partner:'review',model:'haiku',text:'続けて質問'});await wait(()=>{const messages=loadConsultData(ledger,repo,task.id,'review').messages;return messages.filter(m=>m.role==='you').length===2&&!messages.some(m=>m.pending);});const followArgs=readFileSync(argv,'utf8');assert.match(followArgs,/--resume forked-review-session/);assert.doesNotMatch(followArgs,/--fork-session/);
  submitConsultIntent(ledger,repo,{intent:'consult-decide',taskId:task.id,text:'この方法',to:'待ち'});assert.equal(ledger.get(task.id)?.status,'待ち');assert.match(ledger.get(task.id)?.note??'',/答え: この方法/);
  assert.throws(()=>loadConsultData(ledger,'/other',task.id),(e:any)=>e.status===404);
 }finally{ledger.close();if(previous.TASK_LEDGER_CONSULT_DIR===undefined)delete process.env.TASK_LEDGER_CONSULT_DIR;else process.env.TASK_LEDGER_CONSULT_DIR=previous.TASK_LEDGER_CONSULT_DIR;if(previous.TASK_CLAUDE_BIN===undefined)delete process.env.TASK_CLAUDE_BIN;else process.env.TASK_CLAUDE_BIN=previous.TASK_CLAUDE_BIN;rmSync(root,{recursive:true,force:true});}
});

test('Claude 作業役の session は work root の claude-<依頼名>.session から拾う',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-consult-session-'));const work=join(root,'work');const oldWork=process.env.HERDR_WORK;process.env.HERDR_WORK=work;const ledger=new Ledger(join(root,'db.sqlite'));
 try{const repo=join(root,'repo');const task=ledger.add({repo,title:'session',why:'test',brief:'handoff/temp-task.md',worker:'claude'});const taskWork=join(work,'wt','temp-task');(awaitImportMkdir(taskWork));ledger.setRunner(task.id,{workdir:taskWork});mkdirSync(work,{recursive:true});writeFileSync(join(work,'claude-temp-task.session'),'worker-session-id\n');const data=loadConsultData(ledger,repo,task.id);assert.equal(data.partners.find(p=>p.kind==='worker')?.sessionId,'worker-session-id');assert.equal(ledger.sessionId(task.id,'worker'),'worker-session-id');}finally{ledger.close();if(oldWork===undefined)delete process.env.HERDR_WORK;else process.env.HERDR_WORK=oldWork;rmSync(root,{recursive:true,force:true});}
});

function awaitImportMkdir(path:string){mkdirSync(path,{recursive:true});}

test('Pi を指定 session から fork し、読み取り道具だけで返答を記録する（偽 Pi）',async()=>{
 const root=mkdtempSync(join(tmpdir(),'task-consult-pi-'));const chat=join(root,'consult');const bin=join(root,'pi');const argv=join(root,'argv');writeFileSync(bin,`#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(argv)},process.argv.slice(2).join(' '));process.stdout.write('Pi の');setTimeout(()=>process.stdout.write('返答\\n二行目'),20);\n`);chmodSync(bin,0o755);
 const oldChat=process.env.TASK_LEDGER_CONSULT_DIR,oldBin=process.env.TASK_PI_BIN;process.env.TASK_LEDGER_CONSULT_DIR=chat;process.env.TASK_PI_BIN=bin;const ledger=new Ledger(join(root,'db.sqlite'));
 try{const task=ledger.add({repo:root,title:'Pi fork',why:'test',worker:'pi'});ledger.setStatus(task.id,'判断待ち','どうするか');ledger.setSessionId(task.id,'worker','pi-session-id');submitConsultIntent(ledger,root,{intent:'consult-send',taskId:task.id,partner:'worker',model:'pi-default',text:'質問'});await wait(()=>{const m=loadConsultData(ledger,root,task.id,'worker').messages;return m.some(x=>x.text.includes('二行目'))&&!m.some(x=>x.pending);});const messages=loadConsultData(ledger,root,task.id,'worker').messages;assert.deepEqual(messages.map(m=>m.text),['質問','Pi の返答\n二行目']);const args=readFileSync(argv,'utf8');assert.match(args,/--fork pi-session-id/);assert.match(args,/--no-mcp/);assert.match(args,/--no-extensions/);assert.match(args,/--tools read,grep,find,ls/);assert.match(args,/-p --/);}finally{ledger.close();if(oldChat===undefined)delete process.env.TASK_LEDGER_CONSULT_DIR;else process.env.TASK_LEDGER_CONSULT_DIR=oldChat;if(oldBin===undefined)delete process.env.TASK_PI_BIN;else process.env.TASK_PI_BIN=oldBin;rmSync(root,{recursive:true,force:true});}
});
