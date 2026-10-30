import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ledger, Task } from '../ledger.ts';

export type DecisionOption = { label: string; detail: string; recommended: boolean; to: '待ち'|'取り込み中'|'保留'|'やめ'; answer: string };
export type Decision = { situation: string; options: DecisionOption[] };
const DESTINATIONS = new Set(['待ち','取り込み中','保留','やめ']);
export function validDecision(value: unknown): value is Decision {
  if (!value || typeof value !== 'object') return false;
  const d=value as Decision;
  return typeof d.situation==='string' && !!d.situation.trim() && Array.isArray(d.options) && d.options.length>=2 && d.options.length<=4 &&
    d.options[0]?.recommended===true && d.options.filter(o=>o?.recommended===true).length===1 && d.options.every(o=>typeof o.label==='string'&&!!o.label.trim()&&typeof o.detail==='string'&&!!o.detail.trim()&&typeof o.answer==='string'&&!!o.answer.trim()&&DESTINATIONS.has(o.to));
}
export function parseDecision(text:string):Decision|null { const start=text.indexOf('{'),end=text.lastIndexOf('}');if(start<0||end<start)return null;try{const v=JSON.parse(text.slice(start,end+1));return validDecision(v)?v:null;}catch{return null;} }
export function saveDecisionCard(ledger:Ledger,taskId:string,enteredAt:string,json:Decision,model:string):void { ledger.db.prepare('INSERT INTO decision_cards(task_id,entered_at,json,model,created_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id,entered_at) DO UPDATE SET json=excluded.json,model=excluded.model,created_at=excluded.created_at').run(taskId,enteredAt,JSON.stringify(json),model,new Date().toISOString()); }
export function getDecisionCard(ledger:Ledger,taskId:string,enteredAt:string):{json:Decision;model:string}|null {const row=ledger.db.prepare('SELECT json,model FROM decision_cards WHERE task_id=? AND entered_at=?').get(taskId,enteredAt) as {json:string;model:string}|undefined;if(!row)return null;try{const json=JSON.parse(row.json);return validDecision(json)?{json,model:row.model}:null;}catch{return null;}}
export function createDecisionCard(ledger:Ledger,task:Task,enteredAt:string,note:string):Decision|null {
 try {
  const prompt=readFileSync(join(import.meta.dirname,'decision-prompt.md'),'utf8');
  const roots=[task.workdir,task.repo].filter((root):root is string=>!!root);
  const findFile=(relative:string)=>roots.map(root=>join(root,relative)).find(path=>existsSync(path));
  const briefPath=task.brief?findFile(task.brief):undefined;
  const brief=briefPath?readFileSync(briefPath,'utf8').split('\n').slice(0,80).join('\n'):'なし';
  const reportPath=task.brief?findFile(task.brief.replace(/\.md$/,'-report.md')):undefined;
  const report=reportPath?readFileSync(reportPath,'utf8').split('\n').slice(0,40).join('\n'):'なし';
  const input=`${prompt}\n\n## 仕事の題\n${task.title}\n\n## 困りごと（why）\n${task.why}\n\n## 依頼文の先頭 80 行\n${brief}\n\n## 止まった理由\n${note}\n\n## 作業役の報告の先頭 40 行\n${report}`;
  const model=process.env.TASK_DECISION_MODEL||'opus',bin=process.env.TASK_CLAUDE_BIN||'claude',deadline=Date.now()+120_000;
  const events=ledger.events(task.id),last=events.at(-1),prior=events.at(-2);
  const session=ledger.claudeSession(task.id,'review');
  const fromReview=last?.to_status==='判断待ち'&&last.from_status==='レビュー中'&&prior?.to_status==='レビュー中'&&!!session&&session.cwd===(task.workdir??task.repo);
  const cardOnly=`レビューの文脈から判断カードだけを作ってください。状況: ${note}\nJSON の形式は次のとおり。余計な文章を付けないこと: {"situation":"...","options":[{"label":"...","detail":"...","recommended":true,"to":"待ち|取り込み中|保留|やめ","answer":"..."},{"label":"...","detail":"...","recommended":false,"to":"待ち|取り込み中|保留|やめ","answer":"..."}]}`;
  for(let attempt=0;attempt<2;attempt++){
   const remaining=deadline-Date.now();if(remaining<=0)break;
   const fork=fromReview&&attempt===0;
   const args=['-p','--model',model,'--settings','{"disableAllHooks":true}','--strict-mcp-config','--tools',''];
   if(fork)args.push('--resume',session!.session_id,'--fork-session');
   let result:string;
   try { result=execFileSync(bin,args,{encoding:'utf8',timeout:remaining,input:fork?cardOnly:input,stdio:['pipe','pipe','pipe']}); }
   catch { if(fork)continue; throw new Error('decision claude failed'); }
   const parsed=parseDecision(result);if(parsed){saveDecisionCard(ledger,task.id,enteredAt,parsed,model);return parsed;}
  }
 } catch { /* Decision cards are best-effort and never prevent entering 判断待ち. */ }
 return null;
}
export function refreshDecisionCards(ledger:Ledger,id?:string):number {let count=0;for(const task of ledger.list({all:true}).filter(t=>t.status==='判断待ち'&&(!id||t.id===id))){const event=[...ledger.events(task.id)].reverse().find(e=>e.to_status==='判断待ち');if(event){ledger.db.prepare('DELETE FROM decision_cards WHERE task_id=? AND entered_at=?').run(task.id,event.at);if(createDecisionCard(ledger,task,event.at,event.note??''))count++;}}return count;}
