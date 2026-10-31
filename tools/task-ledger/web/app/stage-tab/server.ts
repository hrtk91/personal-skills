import { ACTIVE, filesOverlap, type Ledger, type Task, type Status } from "../../../ledger.ts";
import type { StageName, StageTabData, StageTask, WaitReason } from "./types.js";
import { modelRunsFor } from "./model-runs.ts";

const STAGES: StageName[] = ["出す前", "作業", "確かめ", "レビュー", "取り込み", "本番"];
const stageFor = (status: Status): StageName | null => {
  const map: Partial<Record<Status, StageName>> = { "依頼文待ち":"出す前", "待ち":"出す前", "走行中":"作業", "確かめ中":"確かめ", "レビュー中":"レビュー", "取り込み中":"取り込み", "済":"本番" };
  return map[status] ?? null;
};
const today = (date: Date) => date.toLocaleDateString("sv-SE");

export function loadStageData(ledger: Ledger, repo: string, now = new Date(), goalId?: string): StageTabData {
  const all = ledger.list({ repo, all: true }).filter(t => !goalId || goalId === 'all' || t.goal_id === goalId);
  const todayKey = today(now);
  const completedToday = (t: Task) => t.status === "済" && today(new Date(t.updated_at)) === todayKey;
  const ready = ledger.ready().filter(t => t.repo === repo);
  const readyIds = new Set(ready.map(t => t.id));
  const active = all.filter(t => ACTIVE.includes(t.status));
  const taskRows = new Map<string, StageTask>();
  for (const task of all) {
    const stage = stageFor(task.status);
    if (!stage || (stage === "本番" && (!completedToday(task) || !task.deploy))) continue;
    const position = STAGES.indexOf(stage) as 0|1|2|3|4|5;
    const waitsFor: WaitReason[] = [];
    if (stage === "出す前" && !readyIds.has(task.id)) {
      for (const id of task.after) {
        const predecessor = ledger.get(id);
        if (predecessor && predecessor.status !== "済") {
          waitsFor.push({ type:"after", taskId:id, title:predecessor.title, stage:stageFor(predecessor.status), status:predecessor.status });
        }
      }
      // Explain both active locks and earlier tasks Ledger.ready() selected for this pass.
      for (const other of [...active, ...ready]) {
        if (other.repo !== repo || other.id === task.id || !filesOverlap(task.files, other.files)) continue;
        waitsFor.push({ type:"files", taskId:other.id, title:other.title, files: task.files.length === 0 || other.files.length === 0 ? [...new Set([...task.files,...other.files])] : task.files.filter(f => other.files.some(g => filesOverlap([f],[g]))) });
      }
    }
    const entered = [...ledger.events(task.id)].reverse().find(e => e.to_status === task.status)?.at ?? task.created_at;
    const modelRuns = modelRunsFor(ledger.spans(task.id), task.attempts);
    taskRows.set(task.id, { id:task.id,title:task.title,why:task.why.split(/[\r\n]/,1)[0],status:task.status,stage,position,attempts:task.attempts,enteredAt:entered,waitsFor,worker:task.worker??"pi",model:task.model,deploy:task.deploy,modelRuns });
  }
  const lists = STAGES.map((name,index) => {
    let tasks = [...taskRows.values()].filter(t => t.stage === name);
    if (name === "出す前") {
      const order = new Map(ready.map((t,i)=>[t.id,i]));
      tasks.sort((a,b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.enteredAt.localeCompare(b.enteredAt));
    } else tasks.sort((a,b)=>a.enteredAt.localeCompare(b.enteredAt));
    return { name, position:index as 0|1|2|3|4|5, tasks };
  });
  return {
    stages:lists,
    outside:{ decisions:all.filter(t=>t.status==="判断待ち").length, held:all.filter(t=>t.status==="保留").length, stoppedToday:all.filter(t=>t.status==="やめ"&&today(new Date(t.updated_at))===todayKey).length },
    production:all.filter(completedToday).sort((a,b)=>a.updated_at.localeCompare(b.updated_at)).map(t=>({id:t.id,title:t.title,at:t.updated_at,deploy:t.deploy})),
  };
}
