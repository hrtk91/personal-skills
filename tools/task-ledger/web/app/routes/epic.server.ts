// The Epic list's rows: per Epic (goal) how many tasks are done and how many stopped, plus the tasks in no Epic.
import type { Ledger } from "../../../ledger.ts";

const STOPPED = new Set(["判断待ち", "保留"]);
const ACTIVE = new Set(["走行中", "確かめ中", "レビュー中", "取り込み中"]);

export interface EpicSummary { id: string; title: string; done: number; total: number; stopped: number }
export interface LooseTask { id: string; title: string; status: string }

export function epicList(ledger: Ledger, repo: string, now = new Date()) {
  const tasks = ledger.list({ repo, all: true });
  const day = now.toLocaleDateString("sv-SE");
  const today = (at: string) => new Date(at).toLocaleDateString("sv-SE") === day;
  const epics: EpicSummary[] = ledger.listGoals(repo).map((g) => {
    const mine = tasks.filter((t) => t.goal_id === g.id && t.status !== "やめ");
    return { id: g.id, title: g.title, done: mine.filter((t) => t.status === "済").length, total: mine.length, stopped: mine.filter((t) => STOPPED.has(t.status)).length };
  });
  // Only what is still moving, or finished today, so the list does not grow with the whole history.
  const loose: LooseTask[] = tasks.filter((t) => !t.goal_id && ((t.status !== "済" && t.status !== "やめ") || today(t.updated_at)))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));
  const all = { running: tasks.filter((t) => ACTIVE.has(t.status)).length, waiting: tasks.filter((t) => t.status === "待ち" || t.status === "依頼文待ち").length, doneToday: tasks.filter((t) => t.status === "済" && today(t.updated_at)).length };
  return { epics, all, loose };
}
