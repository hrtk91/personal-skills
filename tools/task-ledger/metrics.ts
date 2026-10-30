import type { Ledger } from './ledger.ts';

export const REVIEW_KINDS = ['終わりの条件が未達','依頼の外の変更','検査が中身を確かめていない','実装の誤り','報告が不正確','依頼文の食い違い','その他'] as const;
export type MetricsOptions = { repo?: string; weeks: number };
export type MetricsResult = { weeks: Array<{ week: string; repo: string; completed: number; firstPass: number; failures: Record<string, number>; reviewKinds: Record<string, number>; medianDecisionMs: number | null; medianRunningToDoneMs: number | null; frequentTitles: Array<{ kind: string; title: string; count: number }> }> };
type Row = { task_id:string; repo:string; title:string; at:string; from_status:string|null; to_status:string; note:string|null; kind:string|null; created_at:string };
export function classify(event: Pick<Row,'note'|'from_status'|'to_status'>): string {
 const note=event.note??'';
 if(event.from_status==='レビュー中'&&event.to_status==='判断待ち'||note.includes('レビューで直すことになった')||note.includes('差し戻し: レビュー:')) return 'レビューの差し戻し';
 if(note.includes('差し戻し: 確かめのコマンド')) return '作業役の検査が落ちた';
 if(note.includes('終わりの条件を満たしていない')) return '作業役の自己申告（未完了）';
 if(note.includes('作業役を回す台本が失敗した')) return '台本・環境の失敗';
 if(note.includes('先に済むはずの')) return '前の仕事待ちで止まった';
 if(note.includes('衝突の印')||note.includes('本体に入れられなかった')||note.includes('衝突')) return '本体との食い違い';
 if(note.includes('本体に入れたあとの確かめが落ちた')) return '取り込み後の検査が落ちた';
 if(note.includes('本番に出せなかった')) return '本番に出せなかった';
 if(event.to_status==='走行中'&&event.from_status!==null) return '作業役への差し戻し';
 return 'その他';
}
const ms=(s:string)=>Date.parse(s);
const weekOf=(s:string)=>{const d=new Date(s);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);};
const median=(values:number[])=>{if(!values.length)return null;values.sort((a,b)=>a-b);const m=Math.floor(values.length/2);return values.length%2?values[m]!:Math.round((values[m-1]!+values[m]!)/2);};
export function metrics(ledger:Ledger, options:MetricsOptions):MetricsResult {
 const now=Date.now(), floor=new Date(now-options.weeks*7*86400000), rows=ledger.db.prepare(`SELECT e.task_id,t.repo,t.title,e.at,e.from_status,e.to_status,e.note,e.kind,t.created_at FROM events e JOIN tasks t ON t.id=e.task_id ORDER BY e.at,e.rowid`).all() as Row[];
 const byTask=new Map<string,Row[]>();for(const r of rows){if(options.repo&&r.repo!==options.repo)continue;byTask.set(r.task_id,[...(byTask.get(r.task_id)??[]),r]);}
 const buckets=new Map<string,{week:string;repo:string;completed:number;firstPass:number;failures:Record<string,number>;reviewKinds:Record<string,number>;decision:number[];running:number[];freq:Map<string,Map<string,number>>}>();
 const bucket=(week:string,repo:string)=>{const k=`${week}\0${repo}`;let b=buckets.get(k);if(!b){b={week,repo,completed:0,firstPass:0,failures:{},reviewKinds:{},decision:[],running:[],freq:new Map()};buckets.set(k,b);}return b;};
 for(const events of byTask.values()) {const first=events[0]!;let failures=0,decisionStart:number|null=null,decisionTotal=0,runningStart:number|null=null;for(const e of events){const time=ms(e.at),c=classify(e);if(e.to_status==='判断待ち'&&decisionStart===null)decisionStart=time;else if(e.from_status==='判断待ち'&&decisionStart!==null){decisionTotal+=Math.max(0,time-decisionStart);decisionStart=null;}const isFailure=(e.to_status==='判断待ち'&&c!=='前の仕事待ちで止まった')||(e.to_status==='走行中'&&e.note?.startsWith('差し戻し:'));if(isFailure){failures++;const b=bucket(weekOf(e.at),e.repo);b.failures[c]=(b.failures[c]??0)+1;if(c==='レビューの差し戻し'){for(const kind of (e.kind?e.kind.split(','):['分類なし']))b.reviewKinds[kind]=(b.reviewKinds[kind]??0)+1;}}if(e.to_status==='走行中'&&runningStart===null)runningStart=time;if(e.to_status==='済'){const b=bucket(weekOf(e.at),e.repo);b.completed++;if(failures===0)b.firstPass++;if(runningStart!==null)b.running.push(Math.max(0,time-runningStart));if(decisionTotal)b.decision.push(decisionTotal);}}
  // use event weeks in requested window only; totals are completed-task based.
  for(const e of events){if(Date.parse(e.at)<floor.getTime())continue;const c=classify(e),isFailure=(e.to_status==='判断待ち'&&c!=='前の仕事待ちで止まった')||(e.to_status==='走行中'&&e.note?.startsWith('差し戻し:'));if(!isFailure)continue;const b=bucket(weekOf(e.at),e.repo);const map=b.freq.get(c)??new Map<string,number>();map.set(first.title,(map.get(first.title)??0)+1);b.freq.set(c,map);}
 }
 const result=[...buckets.values()].filter(b=>Date.parse(b.week)>=floor.getTime()).sort((a,b)=>a.week.localeCompare(b.week)||a.repo.localeCompare(b.repo)).map(b=>({week:b.week,repo:b.repo,completed:b.completed,firstPass:b.firstPass,failures:b.failures,reviewKinds:b.reviewKinds,medianDecisionMs:median(b.decision),medianRunningToDoneMs:median(b.running),frequentTitles:[...b.freq].flatMap(([kind,titles])=>[...titles].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3).map(([title,count])=>({kind,title,count})))}));
 return {weeks:result};
}
export function normalizeReviewKinds(value:unknown):string[]{const items=Array.isArray(value)?value:typeof value==='string'?[value]:[];const kinds=[...new Set(items.map(String).filter(x=>(REVIEW_KINDS as readonly string[]).includes(x)))].slice(0,3);return kinds.length?kinds:['その他'];}
