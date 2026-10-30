import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { main } from './cli.ts';

const channel = join(import.meta.dirname, '../../skills/herdr/channel/bin/channel');
test('watch push and push-audit cover recipients, excluded transitions, Claude notes, missing recipients and failures', () => {
  const dir=mkdtempSync(join(tmpdir(),'task-push-')), db=join(dir,'ledger.sqlite'), log=join(dir,'channel.jsonl');
  const old={db:process.env.TASK_LEDGER_DB,channel:process.env.AGENT_CHANNEL,from:process.env.AGENT_CHANNEL_NAME,bin:process.env.TASK_CHANNEL_BIN};
  process.env.TASK_LEDGER_DB=db;process.env.AGENT_CHANNEL=log;process.env.AGENT_CHANNEL_NAME='task-test';process.env.TASK_CHANNEL_BIN=channel;
  try {
    const l=new Ledger(db);l.watch('/repo/a','claude-a');l.watch('/repo/b','claude-b');
    assert.equal(main(['watch','--repo','/repo/c','--name','claude-c'],()=>{}),0);let listed='';main(['watchers'],s=>listed+=s);assert.match(listed,/claude-c/);assert.equal(main(['watch','--repo','/repo/c','--off'],()=>{}),0);
    const a=l.add({repo:'/repo/a',title:'one',why:'why',brief:'brief'}), b=l.add({repo:'/repo/b',title:'two',why:'why',brief:'brief'});
    const started=Date.now();l.setStatus(a.id,'走行中','running');assert.equal(existsSync(log),false);
    l.setStatus(a.id,'判断待ち','needs decision');
    const first=JSON.parse(readFileSync(log,'utf8').trim().split('\n')[0]);assert.equal(first.to,'claude-a');assert.match(first.body,new RegExp(`${a.id} 判断待ち: one \\[event:`));assert.match(first.body,/\nneeds decision$/);assert.ok(Date.now()-started<1000);
    l.setStatus(a.id,'済','done');l.setStatus(a.id,'やめ','cancelled');
    l.setStatus(b.id,'判断待ち','other repo');assert.equal(readFileSync(log,'utf8').trim().split('\n').length,4);
    const claude=l.add({repo:'/repo/a',title:'self',why:'why',brief:'brief'});l.setStatus(claude.id,'判断待ち','Claude: self');assert.equal(readFileSync(log,'utf8').trim().split('\n').length,4);
    const noWatch=l.add({repo:'/repo/no',title:'none',why:'why',brief:'brief'});l.setStatus(noWatch.id,'判断待ち','no watcher');
    let auditOutput='';const auditCode=main(['push-audit'],s=>auditOutput+=s+'\\n');assert.equal(auditCode,0,auditOutput+'\\n'+readFileSync(log,'utf8'));
    // Simulate a dropped channel write: audit must flag the event and return 1.
    const rows=readFileSync(log,'utf8').trim().split('\n');writeFileSync(log,rows.slice(1).join('\n')+'\n');
    let output='';assert.equal(main(['push-audit'],s=>output+=s+'\n'),1);assert.match(output,/抜けた/);
    // Failed transport must not roll back the status; failure is recorded in push_log.
    process.env.TASK_CHANNEL_BIN=join(dir,'does-not-exist');
    const failing=l.add({repo:'/repo/a',title:'failure',why:'why',brief:'brief'});l.setStatus(failing.id,'判断待ち','transport failure');
    assert.equal(l.get(failing.id)?.status,'判断待ち');assert.equal((l.db.prepare("SELECT outcome FROM push_log WHERE task_id=?").get(failing.id) as {outcome:string}).outcome,'failed');let failedAudit='';assert.equal(main(['push-audit'],s=>failedAudit+=s+'\\n'),1);assert.match(failedAudit,/抜けた/);
    l.close();
  } finally { for(const [key,value] of Object.entries({TASK_LEDGER_DB:old.db,AGENT_CHANNEL:old.channel,AGENT_CHANNEL_NAME:old.from,TASK_CHANNEL_BIN:old.bin})) if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(dir,{recursive:true,force:true}); }
});
