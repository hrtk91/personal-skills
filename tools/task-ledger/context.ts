import type { Ledger, Task } from './ledger.ts';

/** Renders the optional knowledge context attached to a task's Issue/Goal. */
// `issueBody: false` when the Issue's body is already in the brief this context is appended to.
export function taskContext(ledger: Ledger, task: Task, now = new Date(), options: { issueBody?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push('## 作業役とモデル');
  lines.push(`- worker: ${task.worker ?? 'pi（既定）'}`);
  lines.push(`- model: ${task.model ?? '既定'}`);
  lines.push(`- effort: ${task.effort ?? '既定'}`);
  // Issue briefs without a concrete task have no task event history to consult.
  const taskEvents = task.id ? ledger.events(task.id) : [];
  let answerIndex = -1;
  for (let i = 0; i < taskEvents.length; i++) {
    const event = taskEvents[i]!;
    if ((event.from_status === '判断待ち' || event.from_status === '保留')
      && event.to_status !== '判断待ち' && event.to_status !== '保留'
      && event.note?.startsWith('答え: ')) answerIndex = i;
  }
  const answer = answerIndex >= 0 ? taskEvents[answerIndex]!.note!.slice('答え: '.length) : null;
  const workerFinished = answerIndex >= 0 && taskEvents.slice(answerIndex + 1).some((event) =>
    event.from_status === '走行中' && event.to_status === '確かめ中');
  if (answer !== null && !workerFinished) lines.push('## 判断待ちへの答え', answer);
  if (!task.issue_id) return `${lines.join('\n')}\n`;
  const issue = ledger.getIssue(task.issue_id);
  if (!issue) return `${lines.join('\n')}\n`;
  const goal = issue.goal_id ? ledger.getGoal(issue.goal_id) : null;
  if (goal) {
    lines.push('## Goal', `- ${goal.title}`, `- きっかけ: ${goal.why || '（記録なし）'}`, `- 今の工程: ${issue.stage || '（未指定）'}`);
  }
  lines.push('## Issue', `- ${issue.title}`);
  if (options.issueBody !== false) lines.push(`- 中身: ${issue.body || '（記録なし）'}`);
  lines.push(`- 起こした人: ${issue.by}`);
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
