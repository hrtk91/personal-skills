import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/consult.js";
import { getLedger,lastHarnessTime } from "../ledger.server.js";
import { loadGoalData,projects,submitIntent } from "../goal-tab/server.js";
import { DashboardShell,GoalTabView } from "../goal-tab/view.js";
import type { GoalTabIntent,ProjectSummary } from "../goal-tab/types.js";
import { loadConsultData,submitConsultIntent } from "../consult/server.js";
import type { ConsultIntent } from "../consult/types.js";
import { ConsultPanel } from "../consult/view.js";
import styles from "../consult/route.module.css";

export function loader({params,request}:Route.LoaderArgs){const l=getLedger();const current=projects(l).find(p=>p.name===params.name);if(!current)throw new Response('Project not found',{status:404});const url=new URL(request.url);return {data:loadGoalData(l,current.repo),consult:loadConsultData(l,current.repo,params.taskId!,url.searchParams.get('partner')??undefined),last:lastHarnessTime()};}
export async function action({params,request}:Route.ActionArgs){const ledger=getLedger();const current=projects(ledger).find(p=>p.name===params.name);if(!current)throw new Response('Project not found',{status:404});const form=await request.formData();const value=Object.fromEntries(form.entries()) as Record<string,string>;if(value.intent==='consult-decide'||value.intent==='consult-send')return submitConsultIntent(ledger,current.repo,value as unknown as ConsultIntent);submitIntent(ledger,current.repo,value);return {ok:true};}
export function meta(){return [{title:'相談 · task-ledger'}];}
function projectHref(p:ProjectSummary){return `/p/${encodeURIComponent(p.name)}`;}
function tabHref(name:string,tab:string){return tab==='goals'?`/p/${encodeURIComponent(name)}`:`/p/${encodeURIComponent(name)}/${tab}`;}
function consultHref(name:string,taskId:string,partner?:string){return `/p/${encodeURIComponent(name)}/consult/${encodeURIComponent(taskId)}${partner?`?partner=${partner}`:''}`;}
export default function ConsultRoute(){const {data,consult,last}=useLoaderData<typeof loader>();const fetcher=useFetcher();const revalidator=useRevalidator();const writing=consult.messages.some(m=>m.pending);useEffect(()=>{const id=setInterval(()=>{if(revalidator.state==='idle')void revalidator.revalidate();},writing?1500:30000);return()=>clearInterval(id);},[revalidator,writing]);useEffect(()=>{if(fetcher.state==='idle'&&fetcher.data)void revalidator.revalidate();},[fetcher.state,fetcher.data,revalidator]);const foot=`ハーネスは 3 分ごとに回っています。最後: ${last?new Date(last).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'記録なし'}。`;const closeHref=projectHref(data.project);const panel=<ConsultPanel key={consult.partner} data={consult} busy={fetcher.state!=='idle'} closeHref={closeHref} partnerHref={kind=>consultHref(data.project.name,consult.taskId,kind)} submit={(intent:ConsultIntent)=>fetcher.submit(intent as unknown as Record<string,string>,{method:'post'})}/>;
 return <><div className={styles.desktop}><DashboardShell projects={data.projects} current={data.project} tab="goals" hrefFor={projectHref} tabHref={t=>tabHref(data.project.name,t)} foot={foot}><div className={styles.columns}><div className={styles.goal}><GoalTabView data={data} busy={fetcher.state!=='idle'} consultHref={id=>consultHref(data.project.name,id)} submit={(intent:GoalTabIntent)=>fetcher.submit(intent as unknown as Record<string,string>,{method:'post'})}/></div><div className={styles.sidebar}>{panel}</div></div></DashboardShell></div><div className={styles.mobile}>{panel}</div></>;
}
