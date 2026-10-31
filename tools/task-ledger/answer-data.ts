import type { Ledger } from './ledger.ts';
export function goalTaskCounts(ledger:Ledger,repo?:string) {
  const tasks=ledger.list({repo,all:true});
  return { goals:ledger.listGoals(repo).map(g=>{const rows=tasks.filter(t=>t.goal_id===g.id);return {goal:g,done:rows.filter(t=>t.status==='済').length,total:rows.length,stopped:rows.filter(t=>['やめ','保留','判断待ち'].includes(t.status)).length};}), unassigned:tasks.filter(t=>!t.goal_id) };
}
export function dailyAnswerCounts(rows:{at:string;by:string}[]) {
  const result=new Map<string,{day:string;by:string;count:number}>();
  for(const r of rows){const day=r.at.slice(0,10),key=`${day}\0${r.by}`,item=result.get(key)??{day,by:r.by,count:0};item.count++;result.set(key,item);}
  return [...result.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.by.localeCompare(b.by));
}
export function answerDashboardData(ledger:Ledger, principles:{ref:string;title:string}[]=[], now=new Date()) {
  const since=new Date(now.getTime()-7*86400000).toISOString();
  const titleByRef=new Map(principles.map(p=>[p.ref,p.title]));
  const answers=ledger.answersSince(since).filter(a=>a.by==='Claude').map(a=>({...a,principle_title:typeof a.principle==='string'?titleByRef.get(a.principle)??null:null}));
  return { decisions:ledger.list({all:true,status:'判断待ち'}), candidates:ledger.listPrincipleCandidates('案'), answers, goals:goalTaskCounts(ledger), daily:dailyAnswerCounts(ledger.answersSince('0000-01-01T00:00:00.000Z') as {at:string;by:string}[]) };
}
/** Action layer used by dashboard forms; file edits remain an explicit user/Claude step. */
export function processAnswerFeedback(ledger:Ledger,input:{taskId:string;answerAt:string;action:'入れる'|'直して入れる'|'入れない'|'違う';candidateId?:number;finalText?:string;note?:string}):void {
  if(input.action==='違う'){if(!input.note?.trim())throw new Error('違う理由を入力してください');ledger.addAnswerFeedback(input.taskId,input.answerAt,input.note);return;}
  if(!input.candidateId)throw new Error('原則案を選んでください');
  if(input.action==='入れる')ledger.markPrinciple(input.candidateId,'入れた');
  else if(input.action==='直して入れる'){ledger.markPrinciple(input.candidateId,'直して入れる',input.finalText);}
  else ledger.markPrinciple(input.candidateId,'入れない');
}
