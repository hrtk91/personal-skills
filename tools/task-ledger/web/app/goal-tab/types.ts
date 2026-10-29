// The Goal tab's data, as the route's loader returns it and the view draws it (handoff/task-dashboard-design.md).
// The server side (loader, actions) and the view are written by different hands; this file is the contract between them.

export type TaskStatus = "待ち" | "走行中" | "確かめ中" | "レビュー中" | "取り込み中" | "判断待ち" | "保留" | "済" | "やめ" | "取り下げ";

export interface ProjectSummary {
  /** The repository path, as the ledger stores it. */
  repo: string;
  /** The repository's folder name, shown as the project's name. */
  name: string;
  /** Tasks in 判断待ち. */
  waiting: number;
  /** Tasks in 走行中・確かめ中・レビュー中・取り込み中. */
  running: number;
}

export interface DecisionOption { label: string; detail?: string; recommended?: boolean; to?: "待ち"|"取り込み中"|"保留"|"やめ"; answer?: string }

/** A task in 判断待ち. The five fields come from the reviewer or the worker when they wrote them; otherwise only `question`. */
export interface DecisionItem {
  taskId: string;
  title: string;
  /** The problem that started the task, in one plain line (the ledger's why). */
  why?: string;
  goalTitle?: string;
  /** The ledger's note for the move into 判断待ち (why it stopped). */
  question: string;
  situation?: string;
  fields?: { goal?: string; how?: string; done?: string; undecided?: string };
  options?: DecisionOption[];
  /** ISO time it entered 判断待ち. */
  at: string;
}

/** A task as one row: the queue, a Goal's issues, and the tasks outside any Goal. */
export interface TaskRow {
  id: string;
  title: string;
  /** The problem that started the task, in one plain line (the ledger's why). */
  why?: string;
  status: TaskStatus;
  attempts: number;
  /** Who works on it (pi・codex・claude), when known. */
  worker?: string;
  goalTitle?: string;
  issueTitle?: string;
  /** ISO time of the last change. */
  updatedAt: string;
  /** The last event's note, one line (for example the reviewer's reason for sending it back). */
  lastNote?: string;
}

export interface QueueItem extends TaskRow {
  /** Waiting tasks can be moved; running ones cannot. */
  movable: boolean;
  /** Task ids this one waits for (--after), when they are not done yet. */
  after: string[];
  /** Why this waiting task cannot start yet. */
  blockedBy?: string;
}

export type StageState = "done" | "cur" | "stuck" | "todo";
export interface GoalStage { name: string; state: StageState }

export interface IssueRow {
  id: string;
  title: string;
  status: string;
  by: string;
  stage?: string;
  tasks: Array<{ id: string; status: TaskStatus; attempts: number }>;
}

export interface GoalRow {
  id: string;
  title: string;
  why: string;
  status: string;
  stages: GoalStage[];
  /** One line: what is happening now (the running task's title, or what it waits on). */
  now: string;
  counts: { running: number; waiting: number; done: number; decisions: number };
  issues: IssueRow[];
}

export interface GoalTabData {
  project: ProjectSummary;
  projects: ProjectSummary[];
  decisions: DecisionItem[];
  /** Running tasks first, then waiting ones in the order the harness will take them. */
  queue: QueueItem[];
  goals: GoalRow[];
  /** Tasks finished or stopped in the last 7 days that are not in any Goal, newest first. */
  recent: TaskRow[];
  /** ISO time the data was read. */
  readAt: string;
}

/** What the view asks the server to do. The route turns each into a form post to its action. */
export type GoalTabIntent =
  | { intent: "answer"; taskId: string; text: string; to?: "待ち" | "取り込み中" | "やめ" | "保留" }
  | { intent: "move-task"; taskId: string; move: "up" | "down" | "first" }
  | { intent: "move-goal"; goalId: string; move: "up" | "down" }
  | { intent: "create-goal"; title: string; why: string };
