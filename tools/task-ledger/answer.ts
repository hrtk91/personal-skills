// The one way to answer a task waiting for a decision; `task answer` and the dashboard both use it.
import { reapplyRevertedMerge, realAdvanceDeps } from './advance.ts';
import type { Ledger, Status, Task } from './ledger.ts';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { hasPrincipleRef } from './principles.ts';

export const ANSWER_TO: readonly Status[] = ['待ち', 'やめ', '保留', '確かめ中', '取り込み中'];

export function answerTask(ledger: Ledger, id: string, text: string, to: Status = '待ち', attempts?: number, by: 'あなた'|'Claude' = 'Claude', principle: string | null = null): Task {
  const task = ledger.get(id);
  if (!task) throw new Error(`台帳にありません: ${id}`);
  if (!text.trim()) throw new Error('答えが空です');
  if (task.status !== '判断待ち' && task.status !== '保留') throw new Error(`判断待ち・保留ではありません（今は ${task.status}）`);
  if (!ANSWER_TO.includes(to)) throw new Error('--to は 待ち・やめ・保留・確かめ中・取り込み中');
  if (by === 'Claude' && !principle) throw new Error('当てはまる原則が無いなら答えずに判断待ちのまま残す。Claude の答えには --principle <参照> が必要です');
  if (principle) {
    const common = readFileSync(join(homedir(), '.claude/rules/principles.md'), 'utf8');
    const repoPath = join(task.repo, 'PRINCIPLES.md');
    const repo = (() => { try { return readFileSync(repoPath, 'utf8'); } catch { return ''; } })();
    const target = basename(task.repo);
    const valid = principle.startsWith('共通:') ? hasPrincipleRef(common, principle, '共通') : hasPrincipleRef(repo, principle, target);
    if (!valid) throw new Error(`原則の参照がありません: ${principle}`);
  }
  if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 0)) throw new Error('--attempts は 0 以上の整数');
  if ((to === '確かめ中' || to === '取り込み中') && !task.workdir) throw new Error(`作業役のコピーが記録されていないので、${to}には戻せません`);
  // Back to the worker's copy for checking or merging: if a failed check after merging undid the merge with a revert,
  // make the branch's change new again first, or the merge would find nothing to bring in.
  if ((to === '確かめ中' || to === '取り込み中') && task.workdir) {
    const recovery = reapplyRevertedMerge(ledger, task, realAdvanceDeps);
    if (recovery) throw new Error(recovery);
  }
  return ledger.recordAnswer(task.id, text, to, by, principle, attempts);
}
