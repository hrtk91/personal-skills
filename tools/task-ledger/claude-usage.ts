import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tokens = { input: number; cacheRead: number; cacheCreation: number; output: number };
export type UsageRow = Tokens & { at: string; day: string; project: string; caller: string; reason: string | null; model: string; weighted: number; rawWeighted: number };
export type LimitRow = { at: string; five_hour: number | null; five_hour_resets_at: number | null; seven_day: number | null; seven_day_resets_at: number | null };
type Cache = { files: Record<string, { size: number; rows: UsageRow[]; malformed: number }> };
const weights = { input: 1, cacheRead: .1, cacheCreation: 1.25, output: 5 };
const modelFactor = (model: string) => /opus/i.test(model) ? 1 : /haiku/i.test(model) ? .2 : .6;
const validNumber = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : 0;
const text = (x: unknown) => typeof x === 'string' ? x : '';
const contentText = (x: unknown): string => typeof x === 'string' ? x : Array.isArray(x) ? x.map(contentText).join(' ') : x && typeof x === 'object' && 'text' in x ? text((x as {text:unknown}).text) : '';
const isoDay = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? new Date().toLocaleDateString('sv-SE') : d.toLocaleDateString('sv-SE'); };
function caller(session: any, firstUser: string): string {
  if (session.isSidechain) return 'サブエージェント';
  if (session.entrypoint && session.entrypoint !== 'cli') return 'その他の claude -p';
  if (/tools\/task-ledger\/review-prompt\.md|レビュー/.test(firstUser)) return 'レビュー';
  if (/decision-prompt\.md|判断カード/.test(firstUser)) return '判断カード';
  if (/retro-prompt\.md|見張り役/.test(firstUser)) return '夜の見張り役';
  if (/相談/.test(firstUser)) return '相談';
  return '司令塔';
}
function reasonOf(userText: string): string {
  if (userText.includes('<task-notification>')) return /Monitor/i.test(userText) ? '見張り（Monitor）' : /expired/i.test(userText) ? '見張り（expired）' : /task-ledger|台帳/.test(userText) ? '台帳の知らせ' : '裏の命令の終わり';
  if (userText.startsWith('見回り（返事は要らない）')) return '見回り';
  if (/^(夜|朝)の報告を作る/.test(userText)) return '朝夕の報告';
  return 'あなたの発言';
}
function projectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/');
  const match = normalized.match(/\/\.cache\/herdr-([^/]+)\/wt\/([^/]+)/);
  if (match) return match[1]!;
  return normalized;
}
function parseTranscript(path: string, root: string): { rows: UsageRow[]; malformed: number; size: number } {
  const content=readFileSync(path,'utf8'), complete=content.lastIndexOf('\n')+1;
  const rows: UsageRow[] = []; let malformed = 0, firstUser = '', currentUser = '';
  for (const line of content.slice(0,complete).split('\n')) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { malformed++; continue; }
    if (e.type === 'user' && !e.toolUseResult) { const value=contentText(e.message?.content ?? e.content); if(value && !/tool_result/.test(value)) { currentUser=value; if(!firstUser) firstUser=value; } }
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const usage = e.message.usage, model = text(e.message.model), session = e;
    const t: Tokens = { input: validNumber(usage.input_tokens), cacheRead: validNumber(usage.cache_read_input_tokens), cacheCreation: validNumber(usage.cache_creation_input_tokens), output: validNumber(usage.output_tokens) };
    const rawWeighted = t.input * weights.input + t.cacheRead * weights.cacheRead + t.cacheCreation * weights.cacheCreation + t.output * weights.output;
    const uText = firstUser, who=caller(session,uText);
    rows.push({ at: text(e.timestamp) || new Date().toISOString(), day: isoDay(text(e.timestamp)), project: projectName(text(e.cwd) || path), caller: who, reason: who === '司令塔' ? reasonOf(currentUser) : null, model, ...t, rawWeighted, weighted: rawWeighted * modelFactor(model) });
  }
  return { rows, malformed, size:Buffer.byteLength(content.slice(0,complete)) };
}
function quantile(values: number[], q: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.floor((sorted.length-1)*q)]!; }
function leastSquares(rows:Array<{raw:Tokens;delta:number}>):Tokens|null {
 const keys=['input','cacheRead','cacheCreation','output'] as const, matrix=keys.map(a=>keys.map(b=>rows.reduce((s,r)=>s+r.raw[a]*r.raw[b],0))), rhs=keys.map(a=>rows.reduce((s,r)=>s+r.raw[a]*r.delta,0));
 for(let i=0;i<4;i++){let pivot=i;for(let j=i+1;j<4;j++)if(Math.abs(matrix[j]![i]!)>Math.abs(matrix[pivot]![i]!))pivot=j;if(Math.abs(matrix[pivot]![i]!)<1e-12)return null;[matrix[i],matrix[pivot]]=[matrix[pivot]!,matrix[i]!];[rhs[i],rhs[pivot]]=[rhs[pivot]!,rhs[i]!];const divisor=matrix[i]![i]!;for(let k=i;k<4;k++)matrix[i]![k]=matrix[i]![k]!/divisor;rhs[i]=rhs[i]!/divisor;for(let j=0;j<4;j++){if(j===i)continue;const factor=matrix[j]![i]!;for(let k=i;k<4;k++)matrix[j]![k]=matrix[j]![k]!-factor*matrix[i]![k]!;rhs[j]=rhs[j]!-factor*rhs[i]!;}}
 return {input:rhs[0]!,cacheRead:rhs[1]!,cacheCreation:rhs[2]!,output:rhs[3]!};
}
function capacity(points: LimitRow[], rows: UsageRow[], key: 'five_hour'|'seven_day', spanMs: number) {
  const intervals: Array<{ delta: number; percent: number; tokens: number; unpriced: number; raw: Tokens }> = [];
  for (let i=1;i<points.length;i++) { const a=points[i-1]!, b=points[i]!; if (a[key]===null||b[key]===null || a[`${key}_resets_at` as keyof LimitRow] !== b[`${key}_resets_at` as keyof LimitRow] || Date.parse(b.at)-Date.parse(a.at)>spanMs) continue;
    const selected=rows.filter(r=>Date.parse(r.at)>Date.parse(a.at)&&Date.parse(r.at)<=Date.parse(b.at)); const raw=selected.reduce((s,r)=>({input:s.input+r.input,cacheRead:s.cacheRead+r.cacheRead,cacheCreation:s.cacheCreation+r.cacheCreation,output:s.output+r.output}),{input:0,cacheRead:0,cacheCreation:0,output:0});
    const tokens=selected.reduce((s,r)=>s+r.weighted,0), unpriced=selected.reduce((s,r)=>s+r.rawWeighted,0), delta=b[key]!-a[key]!; if(delta>0) intervals.push({delta,tokens,unpriced,percent:tokens/delta,raw});
  }
  const totalPct=intervals.reduce((s,x)=>s+x.delta,0), totalTokens=intervals.reduce((s,x)=>s+x.tokens,0), totalUnpriced=intervals.reduce((s,x)=>s+x.unpriced,0), per=intervals.map(x=>x.percent);
  let coefficients: Tokens | null = null;
  if(intervals.length>=20) coefficients=leastSquares(intervals);
  return { intervals: intervals.length, perPercent: totalPct?totalTokens/totalPct:null, capacity100: totalPct?totalTokens/totalPct*100:null, medianPerPercent:quantile(per,.5), rangePerPercent:{low:quantile(per,.25),high:quantile(per,.75)}, weightedWithModelPrices:totalPct?totalTokens/totalPct:null, weightedWithoutModelPrices:totalPct?totalUnpriced/totalPct:null, capacity100WithModelPrices:totalPct?totalTokens/totalPct*100:null, capacity100WithoutModelPrices:totalPct?totalUnpriced/totalPct*100:null, coefficients };
}
export function getClaudeUsage(days=7, now=Date.now()) {
  const transcriptDir=process.env.CLAUDE_PROJECTS_DIR??join(homedir(),'.claude/projects'), usageDir=process.env.CLAUDE_USAGE_DIR??join(homedir(),'.local/share/claude-usage'), cachePath=join(usageDir,'transcript-usage.json');
  let cache:Cache={files:{}}; try { cache=JSON.parse(readFileSync(cachePath,'utf8')); if(!cache.files) cache={files:{}}; } catch {}
  const root=transcriptDir, fileList:string[]=[];
  function walk(dir:string){let entries;try{entries=readdirSync(dir,{withFileTypes:true})}catch{return;}for(const e of entries){const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl'))fileList.push(p);}}
  walk(root); let malformed=0, changed=false;
  for(const file of fileList){let size=0;try{size=statSync(file).size}catch{continue;}const old=cache.files[file];if(old&&size>=old.size) {if(size===old.size) {malformed+=old.malformed;continue;} try{const handle=openSync(file,'r'), length=size-old.size, buffer=Buffer.alloc(length);try{readSync(handle,buffer,0,length,old.size);}finally{closeSync(handle);}const appended=buffer.toString('utf8'), complete=appended.lastIndexOf('\n')+1, parsed=parseTranscriptContent(appended.slice(0,complete),file,root,old.rows.at(-1));old.rows.push(...parsed.rows);old.size+=Buffer.byteLength(appended.slice(0,complete));old.malformed+=parsed.malformed;malformed+=old.malformed;changed=true;continue;}catch{}}
    const parsed=parseTranscript(file,root);cache.files[file]={size:parsed.size,rows:parsed.rows,malformed:parsed.malformed};malformed+=parsed.malformed;changed=true;
  }
  for(const file of Object.keys(cache.files))if(!fileList.includes(file)){delete cache.files[file];changed=true;}
  if(changed){mkdirSync(usageDir,{recursive:true});writeFileSync(cachePath,JSON.stringify(cache));}
  const rows=Object.values(cache.files).flatMap(f=>f.rows), cutoff=now-days*86400000, recent=rows.filter(r=>Date.parse(r.at)>=cutoff&&Date.parse(r.at)<=now);
  const limitsPath=join(usageDir,'limits.jsonl');let limits:LimitRow[]=[];
  if(existsSync(limitsPath)){try{limits=readFileSync(limitsPath,'utf8').split('\n').filter(Boolean).flatMap(l=>{try{const x=JSON.parse(l);return [{at:x.at,five_hour:x.five_hour??null,five_hour_resets_at:x.five_hour_resets_at??null,seven_day:x.seven_day??null,seven_day_resets_at:x.seven_day_resets_at??null}]}catch{malformed++;return []}})}catch{}}
  const latest=limits.at(-1)??null, last24=limits.filter(x=>Date.parse(x.at)>=now-86400000), prev=last24[0], rate=latest&&prev&&latest.seven_day!==null&&prev.seven_day!==null&&latest.seven_day_resets_at===prev.seven_day_resets_at?(latest.seven_day-prev.seven_day)/(Date.parse(latest.at)-Date.parse(prev.at)):null;
  const exhaustAt=latest&&latest.seven_day!==null&&rate&&rate>0?Date.parse(latest.at)+(100-latest.seven_day)/rate:null;
  const remaining=latest?{sevenDay:latest.seven_day,sevenDayResetsAt:latest.seven_day_resets_at,exhaustAt:exhaustAt&&latest.seven_day_resets_at!==null&&exhaustAt<latest.seven_day_resets_at*1000?new Date(exhaustAt).toISOString():null}:null;
  const max=now-7*86400000, limitPoints=limits.filter(x=>Date.parse(x.at)>=max&&Date.parse(x.at)<=now);
  const byDay=new Map<string,any>();for(const r of recent){const key=`${r.day}\t${r.project}\t${r.caller}\t${r.reason??''}`;let v=byDay.get(key);if(!v){v={day:r.day,project:r.project,caller:r.caller,reason:r.reason,...{input:0,cacheRead:0,cacheCreation:0,output:0,weighted:0}};byDay.set(key,v);}v.input+=r.input;v.cacheRead+=r.cacheRead;v.cacheCreation+=r.cacheCreation;v.output+=r.output;v.weighted+=r.weighted;}
  return { days, rows:[...byDay.values()], events:recent, malformedLines:malformed, remaining, capacity:{sevenDay:capacity(limitPoints,rows,'seven_day',7*86400000),fiveHour:capacity(limitPoints.filter(x=>Date.parse(x.at)>=now-5*3600000),rows,'five_hour',5*3600000)} };
}
function parseTranscriptContent(content:string,path:string,root:string,previous?:UsageRow){const tmp=content.endsWith('\n')?content:content.slice(content.lastIndexOf('\n')+1);const rows:UsageRow[]=[];let malformed=0,userText='';
for(const line of tmp.split('\n').filter(Boolean)){try{const e=JSON.parse(line);if(e.type==='user'&&!e.toolUseResult){const value=contentText(e.message?.content??e.content);if(value&&!/tool_result/.test(value))userText=value;}if(e.type!=='assistant'||!e.message?.usage)continue;const u=e.message.usage,t:Tokens={input:validNumber(u.input_tokens),cacheRead:validNumber(u.cache_read_input_tokens),cacheCreation:validNumber(u.cache_creation_input_tokens),output:validNumber(u.output_tokens)},model=text(e.message.model),rawWeighted=t.input+t.cacheRead*.1+t.cacheCreation*1.25+t.output*5,who=e.isSidechain?'サブエージェント':e.entrypoint&&e.entrypoint!=='cli'?'その他の claude -p':previous?.caller??'司令塔';rows.push({at:e.timestamp,day:isoDay(e.timestamp),project:projectName(e.cwd||path),caller:who,reason:who==='司令塔'?(userText?reasonOf(userText):previous?.reason??'あなたの発言'):null,model,...t,rawWeighted,weighted:rawWeighted*modelFactor(model)});}catch{malformed++;}}return{rows,malformed};}
export function renderClaudeUsage(result: ReturnType<typeof getClaudeUsage>): string {
 const totals=new Map<string,number>();for(const r of result.rows){totals.set(r.day,(totals.get(r.day)??0)+r.weighted);}
 const top=new Map<string,number>();for(const r of result.rows){const k=`${r.caller}・${r.reason??'—'}`;top.set(k,(top.get(k)??0)+r.weighted);}
 return ['日\t換算値',...[...totals].sort((a,b)=>a[0].localeCompare(b[0])).map(([d,n])=>`${d}\t${n.toFixed(1)}`),'','上位 呼び手・理由\t換算値',...[...top].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,n])=>`${k}\t${n.toFixed(1)}`),`壊れた行: ${result.malformedLines}`,`容量推定（7日）: ${JSON.stringify(result.capacity.sevenDay)}`,`容量推定（5時間）: ${JSON.stringify(result.capacity.fiveHour)}`].join('\n');
}
