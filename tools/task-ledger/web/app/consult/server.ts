import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ConsultData, ConsultIntent, ConsultMessage, ConsultPartner } from "./types.js";
import { Ledger, type Task } from "../../../ledger.ts";
import { answerTask } from "../../../answer.ts";

const MODELS = ["opus", "sonnet", "haiku", "pi-default"];
const transcriptDir = () => process.env.TASK_LEDGER_CONSULT_DIR ?? join(homedir(), ".local/share/task-ledger/consult");
const fileFor = (repo: string, taskId: string, kind: string) => join(transcriptDir(), `${createHash('sha256').update(repo).digest('hex').slice(0,16)}-${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${kind}.jsonl`);
const active = new Set<string>();
/** Where the harness keeps Pi's sessions, apart from the everyday ~/.pi/agent/sessions (skills/herdr/agents/pi.sh). */
const PI_HARNESS_SESSIONS=process.env.PI_SESSION_DIR??join(homedir(),'.local/share/herdr/pi-sessions');
/** When the Pi session files were last walked for a task without finding its session. */
const piScanAt = new Map<string, number>();
/** The reply being written, per task and partner. */
const replies = new Map<string, string>();
const now = () => new Date().toISOString();

type StoredMessage = ConsultMessage;
function readMessages(repo: string, taskId: string, kind: string): ConsultMessage[] {
  const path=fileFor(repo,taskId,kind); if(!existsSync(path)) return [];
  return readFileSync(path,"utf8").split("\n").filter(Boolean).flatMap(line=>{try{return [JSON.parse(line) as StoredMessage]}catch{return []}});
}
function storeMessage(repo:string,taskId:string,kind:string, role:ConsultMessage["role"],text:string,pending=false):ConsultMessage {
  mkdirSync(transcriptDir(),{recursive:true}); const message:ConsultMessage={id:`${Date.now()}-${Math.random().toString(36).slice(2)}`,role,text,at:now(),...(pending?{pending:true}:{})};
  appendFileSync(fileFor(repo,taskId,kind),JSON.stringify(message)+"\n");return message;
}
function safeDecode(s:string){try{return decodeURIComponent(s)}catch{return s}}
function workerSession(task:Task):string|undefined {
  if(task.worker==='claude') {
    const briefName=basename(task.brief??task.id,extname(task.brief??''));
    const workRoot=process.env.HERDR_WORK??process.env.CODEX_WORK??join(homedir(),'.cache',`herdr-${basename(task.repo)}`);
    const candidates=[join(workRoot,`claude-${briefName}.session`),...(task.workdir?[join(dirname(dirname(task.workdir)),`claude-${briefName}.session`),join(task.workdir,`claude-${briefName}.session`),join(task.workdir,'.herdr',`claude-${briefName}.session`)]:[])];
    for(const path of candidates)try{const id=readFileSync(path,'utf8').trim();if(id)return id;}catch{}
  }
  if(task.worker==='pi') {
    // The sidebar reloads every few seconds while a reply is written; walk the session files at most once a minute per task.
    const last=piScanAt.get(task.id);if(last!==undefined&&Date.now()-last<60_000)return undefined;piScanAt.set(task.id,Date.now());
    let newest:{mtime:number,id:string}|undefined; let seen=0;
    const visit=(dir:string,depth:number)=>{if(depth>5||seen>5000)return;let entries;try{entries=readdirSync(dir,{withFileTypes:true})}catch{return}for(const ent of entries){const p=join(dir,ent.name);if(ent.isDirectory()){visit(p,depth+1);continue;}if(!ent.isFile()||!ent.name.endsWith('.jsonl'))continue;seen++;try{const st=statSync(p);if(newest&&st.mtimeMs<=newest.mtime)continue;const first=readFileSync(p,"utf8").split("\n",1)[0];const header=JSON.parse(first);const cwd=safeDecode(String(header.cwd??header.path??''));if(cwd===task.workdir||cwd===task.repo)newest={mtime:st.mtimeMs,id:String(header.id??header.sessionId??'')};}catch{}}};
    // The harness keeps Pi's sessions apart from the everyday ones (10/30); older ones may still sit in the everyday folder.
    for(const root of [PI_HARNESS_SESSIONS,join(homedir(),'.pi/agent/sessions')])visit(root,0);if(newest?.id)return newest.id;
  }
  return undefined;
}
function getPartners(ledger:Ledger,task:Task):ConsultPartner[]{
  const worker=ledger.sessionId(task.id,'worker')??workerSession(task);
  if(worker)ledger.setSessionId(task.id,'worker',worker);
  const review=ledger.sessionId(task.id,'review');
  return [{kind:'review',label:'レビュー役（Opus）',...(review?{sessionId:review}:{})},{kind:'worker',label:`作業役（${task.worker??'pi'}）`,...(worker?{sessionId:worker}:{})}];
}
export function loadConsultData(ledger:Ledger,repo:string,taskId:string,partnerInput?:string):ConsultData {
  const task=ledger.get(taskId);if(!task||task.repo!==repo)throw new Response('Task not found',{status:404});
  const partners=getPartners(ledger,task);const requested=partnerInput==='worker'?'worker':partnerInput==='review'?'review':undefined;
  const partner=requested&&partners.find(p=>p.kind===requested)?.sessionId?requested:(partners.find(p=>p.kind==='review')?.sessionId?'review':'worker');
  const selected=partners.find(p=>p.kind===partner)!;
  const key=`${task.id}:${partner}`;const messages=readMessages(repo,task.id,partner);if(active.has(key))messages.push({id:'partner-writing',role:'partner',text:replies.get(key)??'',at:now(),pending:true});
  const model=partner==='review'||task.worker==='claude'?'opus':'pi-default';const models=partner==='review'||task.worker==='claude'?MODELS.filter(m=>m!=='pi-default'):['pi-default'];
  return {taskId:task.id,taskTitle:task.title,question:task.note??task.why,partners,partner,model,models,messages};
}
function fail(status:number,message:string):never{throw new Response(message,{status});}
export function submitConsultIntent(ledger:Ledger,repo:string,value:unknown):{ok:true}{
  if(!value||typeof value!=='object')fail(400,'invalid intent');
  const intent=value as ConsultIntent;
  if(typeof intent.taskId!=='string'||typeof intent.intent!=='string')fail(400,'invalid intent');
  const task=ledger.get(intent.taskId);if(!task||task.repo!==repo)fail(404,'Task not found');
  if(intent.intent==='consult-decide'){
    if(typeof intent.text!=='string')fail(400,'answer text is required');
    try{answerTask(ledger,task.id,intent.text,intent.to??'待ち');}catch(e){fail(400,e instanceof Error?e.message:String(e));}return {ok:true};
  }
  if(intent.intent!=='consult-send')fail(400,'invalid intent');
  if(!['review','worker'].includes(intent.partner))fail(400,'invalid partner');
  if(typeof intent.model!=='string'||!MODELS.includes(intent.model))fail(400,'invalid model');
  if(typeof intent.text!=='string')fail(400,'message is required');
  const partner=getPartners(ledger,task).find(p=>p.kind===intent.partner);if(!partner?.sessionId)fail(400,'session not recorded');
  if(!intent.text.trim())fail(400,'message is empty');
  if(intent.partner==='worker'&&task.worker==='pi'&&intent.model!=='pi-default')fail(400,'pi uses its default model');
  if(intent.partner==='review'&&intent.model==='pi-default')fail(400,'invalid Claude model');
  const key=`${task.id}:${intent.partner}`;if(active.has(key))fail(409,'consult is already running');active.add(key);
  storeMessage(repo,task.id,intent.partner,'you',intent.text.trim());
  const prompt=`${intent.text.trim()}\n\n返答は読みやすい文章で、必要なら短い箇条書きにしてください。台帳やファイルの変更はしないでください。`;
  let child;
  const env={...process.env,TMPDIR:'/tmp'};const priorConsultSession=ledger.consultSessionId(task.id,intent.partner);const resumeId=priorConsultSession??partner.sessionId;const forkId=randomUUID();
  if(task.worker==='pi'&&intent.partner==='worker') {
    const args=priorConsultSession?['--session',resumeId]:['--fork',partner.sessionId,'--session-id',forkId];
    args.push('--session-dir',PI_HARNESS_SESSIONS,'--no-mcp','--no-extensions','--no-skills','--tools','read,grep,find,ls','-p','--',prompt);
    child=spawn(process.env.TASK_PI_BIN??'pi',args,{cwd:task.workdir??task.repo,env,stdio:['ignore','pipe','pipe']});
    if(!priorConsultSession)ledger.setConsultSessionId(task.id,intent.partner,forkId);
  } else {
    const args=['-p','--resume',resumeId,...(priorConsultSession?[]:['--fork-session']),'--model',intent.model==='pi-default'?'opus':intent.model,'--settings','{"disableAllHooks":true}','--strict-mcp-config','--allowedTools','Read','Grep','Glob','--disallowedTools','Edit','Write','NotebookEdit','--output-format','stream-json','--verbose'];
    child=spawn(process.env.TASK_CLAUDE_BIN??'claude',args,{cwd:task.workdir??task.repo,env,stdio:['pipe','pipe','pipe']});child.stdin?.end(prompt);
  }
  // One reply is one message: the text grows in memory while the partner writes (the sidebar shows it as
  // 「書いています」), and is stored once when the process ends. Stream pieces end mid-line or mid-word.
  let output='';let failed='';let stdoutBuffer='';replies.set(key,'');
  const append=(text:string)=>{replies.set(key,(replies.get(key)??'')+text);};
  let sawStreamEvents=false;let sawAssistantText=false;
  const consume=(line:string)=>{try{const event=JSON.parse(line);
    if(event.type==='system'&&event.subtype==='init'&&typeof event.session_id==='string'&&!priorConsultSession)ledger.setConsultSessionId(task.id,intent.partner,event.session_id);
    else if(event.type==='stream_event'){
      const detail=event.event;if(detail?.type==='content_block_delta'&&detail.delta?.text){sawStreamEvents=true;sawAssistantText=true;append(detail.delta.text);}
    } else if(event.type==='content_block_delta'&&event.delta?.text){sawStreamEvents=true;sawAssistantText=true;append(event.delta.text);}
    else if(event.type==='assistant'&&!sawStreamEvents){const content=event.message?.content??[];for(const part of content)if(part.type==='text'){sawAssistantText=true;append(part.text);}}
    else if(event.type==='result'&&event.result&&!sawAssistantText)append(event.result);
  }catch{}};
  const piWorker=intent.partner==='worker'&&task.worker==='pi';
  if(child.stdout)child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;if(piWorker)append(chunk);else{stdoutBuffer+=chunk;let boundary:number;while((boundary=stdoutBuffer.indexOf('\n'))>=0){consume(stdoutBuffer.slice(0,boundary));stdoutBuffer=stdoutBuffer.slice(boundary+1);}}});
  child.stderr?.setEncoding('utf8').on('data',(chunk:string)=>{failed+=chunk;});
  let finished=false;
  const finish=(fallback:string)=>{if(finished)return;finished=true;const text=(replies.get(key)??'').trim();storeMessage(repo,task.id,intent.partner,'partner',text||fallback);replies.delete(key);active.delete(key);};
  child.on('error',(error)=>finish(`相談プロセスを起動できませんでした: ${error.message}`));
  child.on('close',(code)=>{if(stdoutBuffer.trim())consume(stdoutBuffer);finish(code===0?'（返事が空でした）':`相談コマンドが終了コード ${code} で終わりました${failed.trim()?`\n${failed.trim()}`:''}`);});
  return {ok:true};
}
