// The one way to answer a task waiting for a decision; `task answer` and the dashboard both use it.
import { reapplyRevertedMerge, realAdvanceDeps } from './advance.ts';
import type { Ledger, Status, Task } from './ledger.ts';

export const ANSWER_TO: readonly Status[] = ['待ち', 'やめ', '保留', '確かめ中', '取り込み中'];

export function answerTask(ledger: Ledger, id: string, text: string, to: Status = '待ち', attempts?: number): Task {
  const task = ledger.get(id);
  if (!task) throw new Error(`台帳にありません: ${id}`);
  if (!text.trim()) throw new Error('答えが空です');
  if (task.status !== '判断待ち' && task.status !== '保留') throw new Error(`判断待ち・保留ではありません（今は ${task.status}）`);
  if (!ANSWER_TO.includes(to)) throw new Error('--to は 待ち・やめ・保留・確かめ中・取り込み中');
  if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 0)) throw new Error('--attempts は 0 以上の整数');
  if ((to === '確かめ中' || to === '取り込み中') && !task.workdir) throw new Error(`作業役のコピーが記録されていないので、${to}には戻せません`);
  if (to === '確かめ中' && task.workdir) {
    const recovery = reapplyRevertedMerge(ledger, task, realAdvanceDeps);
    if (recovery) throw new Error(recovery);
  }
  return ledger.setStatus(task.id, to, `答え: ${text}`, attempts === undefined ? {} : { attempts });
}
