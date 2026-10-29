// The Issue tab's data (Claude's part, like goal-tab/types.ts). The loader in ./server.ts fills it.
import type { ProjectSummary, TaskStatus } from "../goal-tab/types.js";

export type IssueStatus = "開いている" | "仕事にした" | "済" | "やめ";

export interface IssueTaskRow { id: string; title: string; status: TaskStatus; worker?: string }

export interface IssueRow {
  id: string;
  title: string;
  by: string;
  status: IssueStatus;
  stage?: string;
  createdAt: string;
  /** The filled fields of the Issue (なぜ・やること…), in the ledger's order. */
  fields: { label: string; value: string }[];
  /** Tasks made from this Issue, oldest first. */
  tasks: IssueTaskRow[];
}

export interface IssueGroup { goalId: string | null; goalTitle: string; goalStatus?: string; issues: IssueRow[] }

export interface IssueTabData {
  project: ProjectSummary;
  projects: ProjectSummary[];
  /** One group per Goal in its order, then the Issues outside any Goal. Groups without Issues are left out. */
  groups: IssueGroup[];
}
