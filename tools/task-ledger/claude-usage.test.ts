import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClaudeUsage, renderClaudeUsage } from './claude-usage.ts';
import { main } from './cli.ts';

const assistant=(at:string,usage:any={},model='claude-opus-4',extra:any={})=>JSON.stringify({type:'assistant',timestamp:at,cwd:'/repo/example',entrypoint:'cli',...extra,message:{model,usage:{input_tokens:usage.input??0,cache_read_input_tokens:usage.cacheRead??0,cache_creation_input_tokens:usage.cacheCreation??0,output_tokens:usage.output??0}}});
function setup(){const dir=mkdtempSync(join(tmpdir(),'claude-usage-'));const proj=join(dir,'projects','example');mkdirSync(proj,{recursive:true});const usage=join(dir,'usage');mkdirSync(usage);process.env.CLAUDE_PROJECTS_DIR=join(dir,'projects');process.env.CLAUDE_USAGE_DIR=usage;return{dir,proj,usage};}
const user=(content:string)=>JSON.stringify({type:'user',message:{content}});

test('incremental transcripts classify callers/reasons, calculate token weights, skip corrupt lines and read appends',()=>{
 const env=setup(),file=join(env.proj,'session.jsonl');const at=new Date().toISOString();
 try{
  writeFileSync(file,[user('見回り（返事は要らない）'),assistant(at,{input:100,cacheRead:20,cacheCreation:10,output:2}),'{broken'].join('\n')+'\n');
  const first=getClaudeUsage(7);assert.equal(first.malformedLines,1);assert.equal(first.events.length,1);assert.equal(first.events[0]?.caller,'司令塔');assert.equal(first.events[0]?.reason,'見回り');assert.equal(first.events[0]?.rawWeighted,124.5);assert.equal(first.events[0]?.weighted,124.5);
  appendFileSync(file,assistant(new Date(Date.now()-100).toISOString(),{input:10})+'\n');const second=getClaudeUsage(7);assert.equal(second.events.length,2);assert.equal(second.events.reduce((s,r)=>s+r.input,0),110);
  const text=renderClaudeUsage(second);assert.match(text,/日\t換算値/);assert.match(text,/司令塔・見回り/);
 }finally{rmSync(env.dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('caller buckets and assistant wake reasons carry across tool_result',()=>{
 const env=setup(), file=join(env.proj,'sessions.jsonl'), at=new Date().toISOString();
 try{
  const cases:[string,string,any?][]=[['tools/task-ledger/review-prompt.md','レビュー',{}],['tools/task-ledger/decision/decision-prompt.md','判断カード',{}],['tools/task-ledger/retro/retro-prompt.md','夜の見張り役',{}],['ダッシュボード相談','相談',{}],['普通の対話','サブエージェント',{isSidechain:true}],['普通の対話','その他の claude -p',{entrypoint:'other'}]];
  for(let i=0;i<cases.length;i++){const [prompt,,extra]=cases[i]!;writeFileSync(join(env.proj,`session-${i}.jsonl`),[user(prompt),assistant(new Date(Date.now()-1000+i).toISOString(),{input:1},'claude-sonnet-4',extra)].join('\n')+'\n');}
  writeFileSync(file,[user('普通の対話'),assistant(new Date(Date.now()-500).toISOString(),{input:1}),user('<task-notification> Monitor event'),assistant(new Date(Date.now()-300).toISOString(),{input:1}),user('tool_result output'),assistant(at,{input:1})].join('\n')+'\n');const got=getClaudeUsage(7);assert.deepEqual(got.events.slice(0,6).map(x=>x.caller),cases.map(x=>x[1]));assert.equal(got.events[7]?.reason,'見張り（Monitor）');assert.equal(got.events[8]?.reason,'見張り（Monitor）');assert.equal(got.events[0]?.weighted,.6);
 }finally{rmSync(env.dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('limits estimate ignores reset-crossing intervals, predicts exhaustion, and yields null when missing',()=>{
 const env=setup(),file=join(env.proj,'s.jsonl'),now=Date.now();
 try{
  writeFileSync(file,[user('hello'),assistant(new Date(now-1800000).toISOString(),{input:100},'claude-sonnet-4')].join('\n')+'\n');
  const limits=[{at:new Date(now-3600000).toISOString(),five_hour:20,five_hour_resets_at:now/1000+36000,seven_day:80,seven_day_resets_at:now/1000+5*86400},{at:new Date(now).toISOString(),five_hour:40,five_hour_resets_at:now/1000+36000,seven_day:90,seven_day_resets_at:now/1000+5*86400}];
  writeFileSync(join(env.usage,'limits.jsonl'),limits.map(x=>JSON.stringify(x)).join('\n')+'\n');const got=getClaudeUsage(7,now);assert.equal(got.capacity.sevenDay.intervals,1);assert.equal(got.capacity.sevenDay.capacity100,600);assert.equal(got.capacity.sevenDay.capacity100WithoutModelPrices,1000);assert.equal(got.capacity.sevenDay.coefficients,null);assert.ok(got.remaining?.exhaustAt);
  limits[1]!.seven_day_resets_at=limits[0]!.seven_day_resets_at+1;writeFileSync(join(env.usage,'limits.jsonl'),limits.map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal(getClaudeUsage(7,now).capacity.sevenDay.intervals,0);
  rmSync(join(env.usage,'limits.jsonl'));assert.equal(getClaudeUsage(7,now).remaining,null);
 }finally{rmSync(env.dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('capacity coefficients appear at twenty independent intervals only',()=>{
 const env=setup(), now=Date.now(), reset=now/1000+7*86400, rows:string[]=[], limits:any[]=[];
 try{
  for(let i=0;i<=20;i++){const at=new Date(now-(20-i)*3600000).toISOString();limits.push({at,five_hour:Math.min(100,i),five_hour_resets_at:reset,seven_day:i,seven_day_resets_at:reset});if(i<20){const key=['input','cacheRead','cacheCreation','output'][i%4]!;const values:any={input:0,cacheRead:0,cacheCreation:0,output:0};values[key]=i+1;rows.push(assistant(new Date(Date.parse(at)+1800000).toISOString(),values));}}
  writeFileSync(join(env.proj,'many.jsonl'),rows.join('\n')+'\n');writeFileSync(join(env.usage,'limits.jsonl'),limits.map(x=>JSON.stringify(x)).join('\n')+'\n');const got=getClaudeUsage(7,now);assert.equal(got.capacity.sevenDay.intervals,20);assert.notEqual(got.capacity.sevenDay.coefficients,null);assert.equal(got.capacity.fiveHour.coefficients,null);
 }finally{rmSync(env.dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;}
});

test('CLI renders the table using temporary transcripts',()=>{
 const env=setup(),file=join(env.proj,'cli.jsonl'),now=new Date().toISOString();
 try{
  writeFileSync(file,[user('tools/task-ledger/review-prompt.md review'),assistant(now,{input:5})].join('\n')+'\n');
  process.env.TASK_LEDGER_DB=join(env.dir,'ledger.sqlite');const lines:string[]=[];const code=main(['claude-usage','--days','7'],s=>lines.push(s));assert.equal(code,0);assert.match(lines.join('\n'),/日\t換算値/);assert.match(lines.join('\n'),/レビュー/);
 }finally{rmSync(env.dir,{recursive:true,force:true});delete process.env.CLAUDE_PROJECTS_DIR;delete process.env.CLAUDE_USAGE_DIR;delete process.env.TASK_LEDGER_DB;}
});
