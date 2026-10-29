// The Issue tab's loader: every Issue of a project, grouped by Goal, with the tasks made from each.
import { ISSUE_FIELDS, type Ledger, type IssueFields } from "../../../ledger.ts";
import { projects } from "../goal-tab/server.js";
import type { TaskStatus } from "../goal-tab/types.js";
import type { IssueGroup, IssueRow, IssueStatus, IssueTabData } from "./types.js";

function parseFields(raw: unknown): IssueFields {
  if (raw && typeof raw === "object") return raw as IssueFields;
  try { return JSON.parse(String(raw ?? "{}")) as IssueFields; } catch { return {}; }
}

export function loadIssueData(ledger: Ledger, repo: string): IssueTabData {
  const ps = projects(ledger), project = ps.find((p) => p.repo === repo);
  if (!project) throw new Response("Project not found", { status: 404 });
  const tasks = ledger.list({ repo, all: true });
  const rows = ledger.listIssues({ repo }).map((issue): IssueRow & { goalId: string | null } => {
    // listIssues gives the stored row; the fields are still the JSON column there.
    const fields = parseFields((issue as unknown as { fields_json?: string }).fields_json ?? issue.fields);
    return {
      id: issue.id, title: issue.title, by: issue.by, status: issue.status as IssueStatus, goalId: issue.goal_id,
      ...(issue.stage ? { stage: issue.stage } : {}), createdAt: issue.created_at,
      fields: ISSUE_FIELDS.filter((label) => fields[label]?.trim()).map((label) => ({ label, value: fields[label]!.trim() })),
      tasks: tasks.filter((t) => t.issue_id === issue.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((t) => ({ id: t.id, title: t.title, status: t.status as TaskStatus, worker: [t.worker ?? "pi", t.model].filter(Boolean).join(" ") })),
    };
  });
  const strip = ({ goalId: _goalId, ...row }: IssueRow & { goalId: string | null }): IssueRow => row;
  const groups: IssueGroup[] = ledger.listGoals(repo).map((goal) => ({
    goalId: goal.id, goalTitle: goal.title, goalStatus: goal.status, issues: rows.filter((r) => r.goalId === goal.id).map(strip),
  }));
  const goalIds = new Set(groups.map((g) => g.goalId));
  groups.push({ goalId: null, goalTitle: "Goal に入っていない Issue", issues: rows.filter((r) => !r.goalId || !goalIds.has(r.goalId)).map(strip) });
  return { project, projects: ps, groups: groups.filter((g) => g.issues.length) };
}
