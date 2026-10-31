// Which Epic (goal) each task belongs to, and the Epic list's counts. A task names its Epic directly (goal_id) or,
// for older tasks, through the Issue it came from.
import type { Ledger, Task } from "../../../ledger.ts";
import type { StageTabData } from "../stage-tab/types.js";

const DONE = new Set(["済", "やめ"]);
const STOPPED = new Set(["判断待ち", "保留"]);

export function goalIdOf(ledger: Ledger, task: Task): string | null {
  const direct = (task as Task & { goal_id?: string | null }).goal_id;
  if (direct) return direct;
  return task.issue_id ? ledger.getIssue(task.issue_id)?.goal_id ?? null : null;
}

export interface EpicSummary { id: string; title: string; done: number; total: number; stopped: number }
export interface LooseTask { id: string; title: string; status: string }

export function epicList(ledger: Ledger, repo: string, now = new Date()) {
  const tasks = ledger.list({ repo, all: true });
  const byGoal = new Map<string, Task[]>();
  const loose: LooseTask[] = [];
  const day = now.toLocaleDateString("sv-SE");
  for (const task of tasks) {
    const goal = goalIdOf(ledger, task);
    if (goal) byGoal.set(goal, [...(byGoal.get(goal) ?? []), task]);
    // Only what is still moving, or finished today, so the list does not grow with the whole history.
    else if (!DONE.has(task.status) || new Date(task.updated_at).toLocaleDateString("sv-SE") === day) loose.push({ id: task.id, title: task.title, status: task.status });
  }
  const epics: EpicSummary[] = ledger.listGoals(repo).map((g) => {
    const mine = byGoal.get(g.id) ?? [];
    return { id: g.id, title: g.title, done: mine.filter((t) => t.status === "済").length, total: mine.filter((t) => t.status !== "やめ").length, stopped: mine.filter((t) => STOPPED.has(t.status)).length };
  });
  const all = { running: tasks.filter((t) => ["走行中", "確かめ中", "レビュー中", "取り込み中"].includes(t.status)).length, waiting: tasks.filter((t) => t.status === "待ち" || t.status === "依頼文待ち").length, doneToday: tasks.filter((t) => t.status === "済" && new Date(t.updated_at).toLocaleDateString("sv-SE") === day).length };
  return { epics, all, loose };
}

/** The ids of the tasks in one Epic, or null for 「すべての仕事」. */
export function epicTaskIds(ledger: Ledger, repo: string, goalId: string): Set<string> | null {
  if (goalId === "all") return null;
  return new Set(ledger.list({ repo, all: true }).filter((t) => goalIdOf(ledger, t) === goalId).map((t) => t.id));
}

/** The stage board narrowed to one Epic's tasks (null keeps every task). */
export function narrowStage(data: StageTabData, ids: Set<string> | null): StageTabData {
  if (!ids) return data;
  return { ...data, stages: data.stages.map((stage) => ({ ...stage, tasks: stage.tasks.filter((t) => ids.has(t.id)) })), production: data.production.filter((t) => ids.has(t.id)) };
}
