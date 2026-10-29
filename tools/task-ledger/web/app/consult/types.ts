// The data contract between the consultation sidebar's view (Claude) and its server (Pi).
// Design: handoff/task-dashboard-design.md (右のサイドバー（相談）・相談). Change it only by writing in the report why.

/** Who can be consulted about a task: the review (Opus `claude -p`) or the worker (Pi / Claude), each a recorded session. */
export type ConsultPartner = {
  kind: "review" | "worker";
  /** Shown on the partner chip, e.g. 「レビュー役（Opus）」「作業役（pi）」. */
  label: string;
  /** The recorded session the conversation continues from. Absent when none was recorded: the chip is shown disabled. */
  sessionId?: string;
};

export type ConsultMessage = {
  id: string;
  role: "you" | "partner";
  text: string;
  /** ISO time. */
  at: string;
  /** True while the partner is still writing this message (streamed). */
  pending?: boolean;
};

/** What the sidebar shows for one task. */
export type ConsultData = {
  taskId: string;
  taskTitle: string;
  /** The question the task stopped on (the decision note). */
  question: string;
  partners: ConsultPartner[];
  /** Which partner this conversation is with. */
  partner: ConsultPartner["kind"];
  /** The model the partner answers with; switchable. */
  model: string;
  models: string[];
  messages: ConsultMessage[];
};

/** What the view asks the server to do. */
export type ConsultIntent =
  | { intent: "consult-send"; taskId: string; partner: ConsultPartner["kind"]; model: string; text: string }
  /** Puts the chosen text into the ledger as the task's answer (same as answering on the Goal tab). */
  | { intent: "consult-decide"; taskId: string; text: string; to?: "待ち" | "やめ" | "保留" };
