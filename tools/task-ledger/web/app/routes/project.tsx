import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/project.js";
import { getLedger,lastHarnessTime } from "../ledger.server.js";
import { loadGoalData,projects,submitIntent } from "../goal-tab/server.js";
import { DashboardShell,EmptyTab,GoalTabView,type DashboardTab } from "../goal-tab/view.js";
import type { GoalTabIntent,ProjectSummary } from "../goal-tab/types.js";
import { loadIssueData } from "../issue-tab/server.js";
import { IssueTabView } from "../issue-tab/view.js";
import { loadStageData } from "../stage-tab/server.js";
import type { StageTabData } from "../stage-tab/types.js";

export function loader({params}:Route.LoaderArgs){const list=projects(getLedger());const current=list.find(p=>p.name===params.name);if(!current)throw new Response('Project not found',{status:404});const data=loadGoalData(getLedger(),current.repo);const tab=params.tab??'goals';return {data,tab,issues:tab==='issues'?loadIssueData(getLedger(),current.repo):null,stage:tab==='stage'?loadStageData(getLedger(),current.repo):null,last:lastHarnessTime()};}
export async function action({params,request}:Route.ActionArgs){const current=projects(getLedger()).find(p=>p.name===params.name);if(!current)throw new Response('Project not found',{status:404});const form=await request.formData();submitIntent(getLedger(),current.repo,Object.fromEntries(form.entries()) as Record<string,string>);return {ok:true};}
export function meta(){return [{title:'task-ledger'}];}
function hrefFor(p:ProjectSummary){return `/p/${encodeURIComponent(p.name)}`;}
function tabHref(name:string,tab:DashboardTab){return tab==='goals'?`/p/${encodeURIComponent(name)}`:`/p/${encodeURIComponent(name)}/${tab}`;}
function consultHref(name:string,taskId:string){return `/p/${encodeURIComponent(name)}/consult/${encodeURIComponent(taskId)}`;}
function StageView({data}:{data:StageTabData}){return <section><h2>工程</h2><p>判断待ち {data.outside.decisions} ・ 保留 {data.outside.held} ・ やめ（今日） {data.outside.stoppedToday}</p>{data.stages.map(stage=><section key={stage.name}><h3>{stage.name}（{stage.tasks.length}）</h3>{stage.tasks.map(task=><article key={task.id}><strong>{task.title}</strong>{task.waitsFor.map((wait,i)=><p key={`${wait.taskId}-${i}`}>待ち: {wait.type==='after'?`${wait.title}（${wait.stage ?? wait.status}）`:`${wait.title}（${wait.files.join('・')}）`}</p>)}</article>)}</section>)}<section><h3>今日 本番</h3>{data.production.map(task=><p key={task.id}>{task.title}（{task.deploy?'本番':'取り込んだ'}） — {new Date(task.at).toLocaleTimeString('ja-JP')}</p>)}</section></section>;}
export default function Project(){const {data,tab,issues,stage,last}=useLoaderData<typeof loader>();const fetcher=useFetcher();const revalidator=useRevalidator();useEffect(()=>{const id=setInterval(()=>{if(revalidator.state==='idle')void revalidator.revalidate();},30000);return()=>clearInterval(id);},[revalidator]);useEffect(()=>{if(fetcher.state==='idle'&&fetcher.data)void revalidator.revalidate();},[fetcher.state,fetcher.data,revalidator]);const currentTab=(['issues','stage','docs','retro'].includes(tab)?tab:'goals') as DashboardTab;const foot=`ハーネスは 3 分ごとに回っています。最後: ${last?new Date(last).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'記録なし'}。`;
 return <DashboardShell projects={data.projects} current={data.project} tab={currentTab} hrefFor={hrefFor} tabHref={t=>tabHref(data.project.name,t)} foot={foot}>{currentTab==='goals'?<GoalTabView data={data} busy={fetcher.state!=='idle'} consultHref={id=>consultHref(data.project.name,id)} submit={(intent:GoalTabIntent)=>fetcher.submit(intent as unknown as Record<string,string>,{method:'post'})}/>:currentTab==='issues'&&issues?<IssueTabView data={issues}/>:currentTab==='stage'&&stage?<StageView data={stage}/>: <EmptyTab title={currentTab==='docs'?'資料':'振り返り'} note="まだありません。"/>}</DashboardShell>;
}
