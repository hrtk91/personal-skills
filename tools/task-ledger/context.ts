import { existsSync, readFileSync } from 'node:fs';
import type { Ledger, Task } from './ledger.ts';

/** Renders the optional knowledge context attached to a task's Issue/Goal. */
// `issueBody: false` when the Issue's body is already in the brief this context is appended to.
export function taskContext(ledger: Ledger, task: Task, now = new Date(), options: { issueBody?: boolean; taskSpecificOnly?: boolean } = {}): string {
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
  const sendBackIndex = taskEvents.findLastIndex((event) => event.to_status === '走行中' && event.note?.startsWith('差し戻し: '));
  const sendBack = sendBackIndex >= 0 ? taskEvents[sendBackIndex]! : null;
  const workerFinished = (index: number) => taskEvents.slice(index + 1).some((event) =>
    event.from_status === '走行中' && event.to_status === '確かめ中');
  if (answer !== null && !workerFinished(answerIndex)) lines.push('## 判断待ちへの答え', answer);
  if (sendBack?.note && !workerFinished(sendBackIndex)) {
    const [reasonLine, ...rest] = sendBack.note.slice('差し戻し: '.length).split('\n');
    const reason = reasonLine?.replace(/\s*（詳しく: .*）$/, '') ?? '';
    const logPath = reasonLine?.match(/（詳しく: (.+)）$/)?.[1] ?? rest.join('\n').match(/^詳しく: (.+)$/m)?.[1];
    let detail: string[] = [];
    if (logPath && existsSync(logPath)) {
      try { detail = readFileSync(logPath, 'utf8').split('\n').slice(0, 80); } catch { /* reason remains useful without the log */ }
    } else if (rest.length && !logPath) detail = rest.slice(0, 80);
    lines.push('## 今回の差し戻し', `- ${reason}`, ...detail);
  }
  if (options.taskSpecificOnly || !task.issue_id) return `${lines.join('\n')}\n`;
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
    const reason = (event.note ?? '').split('\n', 1)[0].replace(/^差し戻し[:：]?\s*/, '').replace(/\s*（詳しく: .*）$/, '').trim() || '理由の記録なし';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  lines.push('## 直近 7 日の差し戻し理由');
  const top = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  if (!top.length) lines.push('- なし');
  else for (const [reason, count] of top) lines.push(`- ${reason}（${count}回）`);
  return `${lines.join('\n')}\n`;
}
