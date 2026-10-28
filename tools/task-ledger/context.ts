import type { Ledger, Task } from './ledger.ts';

/** Renders the optional knowledge context attached to a task's Issue/Goal. */
export function taskContext(ledger: Ledger, task: Task, now = new Date()): string {
  if (!task.issue_id) return '';
  const issue = ledger.getIssue(task.issue_id);
  if (!issue) return '';
  const goal = issue.goal_id ? ledger.getGoal(issue.goal_id) : null;
  if (!goal && !issue) return '';
  const lines: string[] = [];
  if (goal) {
    lines.push('## Goal', `- ${goal.title}`, `- きっかけ: ${goal.why || '（記録なし）'}`, `- 今の工程: ${issue.stage || '（未指定）'}`);
  }
  lines.push('## Issue', `- ${issue.title}`, `- 中身: ${issue.body || '（記録なし）'}`, `- 起こした人: ${issue.by}`);
  if (goal) {
    const docs = ledger.listDocs({ repo: task.repo, goal: goal.id });
    lines.push('## 資料');
    if (!docs.length) lines.push('- なし');
    else for (const doc of docs) lines.push(`- ${doc.path || doc.title}`);
  }
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const events = ledger.db.prepare("SELECT e.note FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.repo=? AND e.at>=? AND e.note LIKE '%差し戻し%' ORDER BY e.at DESC").all(task.repo, since) as { note: string | null }[];
  const reasons = new Map<string, number>();
  for (const event of events) {
    const reason = (event.note ?? '').replace(/^差し戻し[:：]?\s*/, '').trim() || '理由の記録なし';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  lines.push('## 直近 7 日の差し戻し理由');
  const top = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  if (!top.length) lines.push('- なし');
  else for (const [reason, count] of top) lines.push(`- ${reason}（${count}回）`);
  return `${lines.join('\n')}\n`;
}
