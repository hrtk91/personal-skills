import type { Status } from "../../../ledger.ts";

export type StageName = "出す前" | "作業" | "確かめ" | "レビュー" | "取り込み" | "本番";
export type WaitReason =
  | { type: "after"; taskId: string; title: string; stage: StageName | null; status: Status }
  | { type: "files"; taskId: string; title: string; files: string[] };
// 回ごとの実際の起動値。recorded が false の回は記録が無い（agent は「記録なし」、他は null）。
export interface ModelRun { role: "作業役"|"レビュー役"; agent: string; provider: string|null; model: string|null; effort: string|null; fast: boolean|null; attempt: number; recorded: boolean }
export interface StageTask {
  id: string; title: string; why: string; status: Status; stage: StageName; position: 0|1|2|3|4|5;
  attempts: number; enteredAt: string; waitsFor: WaitReason[]; worker: string; model: string | null; deploy: boolean;
  modelRuns: ModelRun[];
}
export interface StageTabData {
  stages: Array<{ name: StageName; position: 0|1|2|3|4|5; tasks: StageTask[] }>;
  outside: { decisions: number; held: number; stoppedToday: number };
  production: Array<{ id: string; title: string; at: string; deploy: boolean }>;
}
