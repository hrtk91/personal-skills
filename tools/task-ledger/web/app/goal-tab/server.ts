import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger, ACTIVE, filesOverlap, type Task, type Goal, type Issue } from "../../../ledger.ts";
import { answerTask } from "../../../answer.ts";
import { metrics } from "../../../metrics.ts";
import type { DecisionItem, GoalTabData, GoalRow, IssueRow, TaskRow, TaskStatus, StageState, ProjectSummary, ClaudeUsageSummary } from "./types.js";

const RUNNING = new Set<string>(ACTIVE);
let usageCache: { at: number; summary: ClaudeUsageSummary } | null = null;
let usageLoading = false;
let usageReadCount = 0;
export function claudeUsageReadCountForTest() { return usageReadCount; }
export function resetClaudeUsageForTest() { usageCache = null; usageLoading = false; usageReadCount = 0; }
export function expireClaudeUsageCacheForTest() { if (usageCache) usageCache.at = Date.now() - 60_001; }
export function claudeUsageLoadingForTest() { return usageLoading; }
function usageSummary(now: number): ClaudeUsageSummary {
 const fresh = usageCache && Date.now() - usageCache.at < 60_000;
 if (!fresh && !usageLoading) {
  usageLoading = true;
  usageReadCount++;
  const started = performance.now();
  const worker = new Worker(join(process.cwd(), '..', 'claude-usage-worker.ts'), { workerData: { now } });
  let settled = false;
  const finish = (summary?: ClaudeUsageSummary, error?: string) => {
   if (settled) return; settled = true; usageLoading = false;
   if (error) {
    console.error('Claude usage read failed:', error);
    if (!usageCache) usageCache = { at: Date.now(), summary: { error } };
   } else if (summary) usageCache = { at: Date.now(), summary };
   void worker.terminate();
  };
  worker.once('message', (message: any) => {
   if (!message?.ok) { finish(undefined, String(message?.error ?? 'Unknown worker error')); return; }
   const raw = message.result;
   const groups = (rows: typeof raw.rows) => {
    const callerSums = new Map<string, number>(), reasonSums = new Map<string, { caller: string; reason: string | null; weighted: number }>();
    for (const r of rows) { callerSums.set(r.caller, (callerSums.get(r.caller) ?? 0) + r.weighted); const key = JSON.stringify([r.caller,r.reason]); const v = reasonSums.get(key) ?? { caller:r.caller, reason:r.reason, weighted:0 }; v.weighted += r.weighted; reasonSums.set(key,v); }
    return { byCaller:[...callerSums].map(([caller,weighted])=>({caller,weighted})).sort((a,b)=>b.weighted-a.weighted).slice(0,8), byCallerReason:[...reasonSums.values()].sort((a,b)=>b.weighted-a.weighted).slice(0,8) };
   };
   const remaining = raw.remaining, capacity = (c: typeof raw.capacity.sevenDay) => ({ perPercent:c.perPercent, median:c.medianPerPercent, low:c.rangePerPercent.low, high:c.rangePerPercent.high, intervals:c.intervals });
   const today = new Date(now).toLocaleDateString('sv-SE');
   const byDay = new Map<string, { day:string; caller:string; weighted:number }>();
   for (const r of raw.rows) { const k = `${r.day}\t${r.caller}`, v = byDay.get(k) ?? { day:r.day, caller:r.caller, weighted:0 }; v.weighted += r.weighted; byDay.set(k,v); }
   const summary: ClaudeUsageSummary = {
    now:{sevenDay:{percent:remaining?.sevenDay??null,resetsAt:remaining?.sevenDayResetsAt==null?null:new Date(remaining.sevenDayResetsAt*1000).toISOString()},fiveHour:{percent:remaining?.fiveHour??null,resetsAt:remaining?.fiveHourResetsAt==null?null:new Date(remaining.fiveHourResetsAt*1000).toISOString()}},
    pace:{perHour:remaining?.pacePerHour??null,exhaustAt:remaining?.exhaustAt??null,since:remaining?.paceSince??null,hours:remaining?.paceSince&&remaining.observedAt?Math.max(0,(Date.parse(remaining.observedAt)-Date.parse(remaining.paceSince))/3600000):null},
    capacity:{sevenDay:capacity(raw.capacity.sevenDay),fiveHour:capacity(raw.capacity.fiveHour)},
    today:groups(raw.rows.filter((r:any)=>r.day===today)), week:groups(raw.rows),
    days:[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.caller.localeCompare(b.caller)), readMs:performance.now()-started,
   };
   finish(summary);
  });
  worker.once('error', error => finish(undefined, error.stack ?? error.message));
  worker.once('exit', code => { if (!settled && code !== 0) finish(undefined, `worker exited with code ${code}`); });
 }
 if (fresh || (usageCache && !usageLoading)) return usageCache!.summary;
 return usageCache?.summary ?? { pending:true };
}
const mapStatus = (s:string):TaskStatus => (s === '取り下げ' ? '取り下げ' : s) as TaskStatus;
function repoName(repo:string) { return repo.split('/').filter(Boolean).at(-1) ?? repo; }
// Every git repository under ~/repos is listed (10/29 「台帳にないプロジェクトも出す」): the ones with work in
// the ledger first (most decisions, then most running), then the rest by name.
const REPOS_DIR=process.env.TASK_DASHBOARD_REPOS_DIR??join(homedir(),'repos');
function reposOnDisk():string[] {try{return readdirSync(REPOS_DIR,{withFileTypes:true}).filter(d=>d.isDirectory()&&existsSync(join(REPOS_DIR,d.name,'.git'))).map(d=>join(REPOS_DIR,d.name));}catch{return [];}}
export function projects(ledger:Ledger):ProjectSummary[] {
  const inLedger=new Set([...ledger.list({all:true}).map(t=>t.repo),...ledger.listGoals().map(g=>g.repo),...ledger.listIssues().map(i=>i.repo)]);
  const summary=(repo:string):ProjectSummary=>{const ts=ledger.list({repo});return {repo,name:repoName(repo),waiting:ts.filter(t=>t.status==='判断待ち').length,running:ts.filter(t=>RUNNING.has(t.status)).length};};
  const known=[...inLedger].map(summary).sort((a,b)=>b.waiting-a.waiting||b.running-a.running||a.name.localeCompare(b.name));
  const rest=reposOnDisk().filter(r=>!inLedger.has(r)).map(summary).sort((a,b)=>a.name.localeCompare(b.name));
  return [...known,...rest];
}
function row(ledger:Ledger,t:Task, goal?:Goal|null, issue?:Issue|null):TaskRow {
  const ev=ledger.events(t.id).at(-1); return {id:t.id,title:t.title,status:mapStatus(t.status),attempts:t.attempts,worker:[t.worker??"pi",t.model].filter(Boolean).join(" "),...(goal?{goalTitle:goal.title}:{}),...(issue?{issueTitle:issue.title}:{}),updatedAt:t.updated_at,...(t.why?{why:t.why}:{}),...(ev?.note?{lastNote:ev.note}:{})};
}
export function loadGoalData(ledger:Ledger, repo:string, now=new Date()):GoalTabData {
 const ps=projects(ledger), project=ps.find(p=>p.repo===repo); if(!project) throw new Response('Project not found',{status:404});
 const all=ledger.list({repo,all:true}), goals=ledger.listGoals(repo), issues=ledger.listIssues({repo});
 const goalById=new Map(goals.map(g=>[g.id,g])), issueById=new Map(issues.map(i=>[i.id,i]));
 const linkedGoal=(t:Task)=>t.issue_id?goalById.get(issueById.get(t.issue_id)?.goal_id??''):undefined;
 const decisions:DecisionItem[]=all.filter(t=>t.status==='判断待ち').map(t=>{
   const events=ledger.events(t.id), entered=[...events].reverse().find(e=>e.to_status==='判断待ち');
   const note=entered?.note??t.note??'';
   let parsed:any; try { const match=note.match(/\{[\s\S]*\}/); if(match) parsed=JSON.parse(match[0]); } catch {}
   const card=entered?ledger.decisionCard(t.id,entered.at):null;
   const report=t.brief??''; const pick=(key:string, label:string)=>parsed?.[key]??parsed?.fields?.[key]??parsed?.[label]??report.match(new RegExp(`^##?\\s*${label}\\s*\\n([\\s\\S]*?)(?=\\n##?\\s|$)`,'m'))?.[1]?.trim();
   const fields={goal:pick('goal','最終的なゴール'),how:pick('how','どう実現するか'),done:pick('done','やったこと'),undecided:pick('undecided','決められないこと')};
   const options=parsed?.options??parsed?.選択肢;
   return {taskId:t.id,title:t.title,...(t.why?{why:t.why}:{}),...(linkedGoal(t)?{goalTitle:linkedGoal(t)!.title}:{}),question:(card?.json.situation??note)||'【仮】判断が必要です。',...(Object.values(fields).some(Boolean)?{fields}:{}),...(Array.isArray(options)?{options}:{}),...(card?{situation:card.json.situation,options:card.json.options}:{}),at:entered?.at??t.updated_at};
 });
 const ready=ledger.ready().filter(t=>t.repo===repo), running=all.filter(t=>RUNNING.has(t.status)).sort((a,b)=>a.updated_at.localeCompare(b.updated_at));
 const waiting=all.filter(t=>t.status==='待ち'), readyIds=new Set(ready.map(t=>t.id));
 const blocked=waiting.filter(t=>!readyIds.has(t.id)).sort((a,b)=>a.priority-b.priority||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
 const queueTasks=[...running,...ready.filter(t=>!running.some(r=>r.id===t.id)),...blocked];
 const blockerTasks=[...running,...ready];
 const blockedReason=(t:Task):string=>{
   const unfinished=t.after.find(id=>ledger.get(id)?.status!=='済');
   if(unfinished)return `${unfinished} が終わるのを待っています`;
   const overlap=blockerTasks.find(other=>other.id!==t.id&&other.repo===t.repo&&filesOverlap(t.files,other.files));
   if(overlap)return `${overlap.id} が終わるのを待っています（触るファイルが重なるため）`;
   if(!t.brief?.trim())return '依頼文がまだありません';
   return '始める条件がそろうのを待っています';
 };
 const queue=queueTasks.map(t=>({...row(ledger,t,linkedGoal(t),t.issue_id?issueById.get(t.issue_id):null),movable:t.status==='待ち',after:t.after.filter(id=>ledger.get(id)?.status!=='済'),...(!readyIds.has(t.id)&&!RUNNING.has(t.status)?{blockedBy:blockedReason(t)}:{})}));
 const goalRows:GoalRow[]=goals.map(g=>{
  const gi=issues.filter(i=>i.goal_id===g.id), its=all.filter(t=>t.issue_id&&gi.some(i=>i.id===t.issue_id));
  const stages=g.stages.map(name=>{const ts=its.filter(t=>gi.find(i=>i.id===t.issue_id)?.stage===name);let state:StageState='todo';if(ts.length&&ts.every(t=>t.status==='済'))state='done';else if(ts.some(t=>t.status==='判断待ち'||t.status==='保留'))state='stuck';else if(ts.some(t=>RUNNING.has(t.status)))state='cur';return {name,state};});
  const issueRows:IssueRow[]=gi.map(i=>({id:i.id,title:i.title,status:i.status,by:i.by,...(i.stage?{stage:i.stage}:{}),tasks:its.filter(t=>t.issue_id===i.id).map(t=>({id:t.id,status:mapStatus(t.status),attempts:t.attempts}))}));
  const ts=its, active=ts.find(t=>RUNNING.has(t.status)), stuck=ts.find(t=>t.status==='判断待ち'||t.status==='保留');
  return {id:g.id,title:g.title,why:g.why,status:g.status,stages,now:active?.title??stuck?.note??'',counts:{running:ts.filter(t=>RUNNING.has(t.status)).length,waiting:ts.filter(t=>t.status==='待ち').length,done:ts.filter(t=>t.status==='済').length,decisions:ts.filter(t=>t.status==='判断待ち').length},issues:issueRows};
 });
 const goalIssueIds=new Set(issues.filter(i=>i.goal_id).map(i=>i.id)), cutoff=now.getTime()-7*86400000;
 const recent=all.filter(t=>['済','やめ','取り下げ'].includes(t.status)&&(!t.issue_id||!goalIssueIds.has(t.issue_id))&&Date.parse(t.updated_at)>=cutoff).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,30).map(t=>row(ledger,t));
 const claudeUsage=usageSummary(now.getTime()), dashboardMetrics=metrics(ledger,{repo,weeks:4});
 return {project,projects:ps,decisions,queue,goals:goalRows,recent,metrics:dashboardMetrics,claudeUsage,readAt:now.toISOString()};
}
export function submitIntent(ledger:Ledger, repo:string, data:Record<string,string>) {
 const text=(k:string)=>data[k]??'';
 switch(text('intent')) {
  case 'answer': {const t=ledger.get(text('taskId'));if(!t||t.repo!==repo)throw new Response('Task not found',{status:404});let answer=text('text'),to=text('to')||'待ち';if(!text('to')){const event=[...ledger.events(t.id)].reverse().find(e=>e.to_status==='判断待ち');const card=event?ledger.decisionCard(t.id,event.at):null;const label=answer.split('。',1)[0];const selected=card?.json.options.find(option=>option.label===label);if(selected){to=selected.to;answer=[selected.answer,...answer.split('。').slice(1).filter(Boolean)].join('。');}}if(!['待ち','取り込み中','やめ','保留'].includes(to))throw new Response('invalid answer destination',{status:400});try{answerTask(ledger,t.id,answer,to as any);if(to==='取り込み中'){ledger.releaseRunner(t.id);const bin=process.env.TASK_BIN||join(import.meta.dirname,'../../../bin/task');const reportFailure=(error:unknown)=>{const reason=error instanceof Error?error.message:String(error);process.stderr.write(`task advance 起動失敗: ${reason.replace(/[\r\n]+/g,' ')}\n`);};try{const child=spawn(bin,['advance',t.id],{detached:true,stdio:'ignore',env:{...process.env,TASK_LEDGER_DB:ledger.path}});child.on('error',reportFailure);child.unref();}catch(error){reportFailure(error);}}}catch(e){throw new Response(e instanceof Error?e.message:String(e),{status:400});}return {ok:true};}
  case 'move-task': {const t=ledger.get(text('taskId'));if(!t||t.repo!==repo)throw new Response('Task not found',{status:404});if(t.status!=='待ち')throw new Response('動いている仕事は動かせません', {status:400});const move=text('move');if(!['up','down','first'].includes(move))throw new Response('invalid move',{status:400});ledger.setPriority(t.id,move as any);return {ok:true};}
  case 'move-goal': {const g=ledger.getGoal(text('goalId'));if(!g||g.repo!==repo)throw new Response('Goal not found',{status:404});ledger.moveGoal(g.id,text('move') as 'up'|'down');return {ok:true};}
  case 'create-goal': ledger.addGoal({repo,title:text('title'),why:text('why')});return {ok:true};
  default: throw new Response('Unknown intent',{status:400});
 }
}
