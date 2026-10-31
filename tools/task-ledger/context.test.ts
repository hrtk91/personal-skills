if (process.env.TASK_BIN === undefined) process.env.TASK_BIN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.ts';
import { taskContext } from './context.ts';
import { runOnce, type RunDeps } from './run.ts';

test('task context omits worker settings and, when linked, includes Goal, Issue, docs, and recent return reasons', () => {
  let now = new Date('2026-10-28T12:00:00Z');
  const ledger = new Ledger(':memory:', () => now);
  const repo = '/r/app';
  const goal = ledger.addGoal({ repo, title: 'Goal', why: 'ユーザーの言葉' });
  const issue = ledger.addIssue({ repo, title: 'Issue', body: '中身', by: 'Claude', goal_id: goal.id, stage: '設計' });
  const task = ledger.add({ repo, title: 'task', why: 'why', brief: 'brief', issue_id: issue.id });
  const unrelated = ledger.add({ repo, title: 'no context', why: 'why', brief: 'brief' });
  ledger.addDoc({ repo, kind: '仕様', title: '仕様書', goal_id: goal.id, path: 'handoff/spec.md' });
  ledger.addDoc({ repo, kind: '説明', title: '本文資料', goal_id: goal.id, body: '内容' });

  for (const reason of ['不足資料', '不足資料', '不足資料', '不足資料', '検査失敗', '検査失敗', '検査失敗', '要件違い', '要件違い', '4位']) {
    now = new Date(now.getTime() + 1000);
    const eventTask = ledger.add({ repo, title: `差し戻し ${reason}`, why: 'why', brief: 'brief' });
    ledger.setStatus(eventTask.id, '走行中', `差し戻し: ${reason}`);
  }
  now = new Date('2026-10-20T12:00:00Z');
  const old = ledger.add({ repo, title: '古い差し戻し', why: 'why', brief: 'brief' });
  ledger.setStatus(old.id, '走行中', '差し戻し: 古い理由');
  now = new Date('2026-10-28T12:00:00Z');

  assert.doesNotMatch(taskContext(ledger, unrelated, now), /作業役とモデル|worker:|model:|effort:/);
  ledger.setStatus(unrelated.id, '判断待ち', '判断が必要');
  assert.doesNotMatch(taskContext(ledger, ledger.get(unrelated.id)!, now), /## 判断待ちへの答え/);
  const context = taskContext(ledger, task, now);
  assert.match(context, /## Goal[\s\S]*Goal[\s\S]*きっかけ: ユーザーの言葉[\s\S]*今の工程: 設計/);
  assert.match(context, /## Issue[\s\S]*Issue[\s\S]*中身: 中身[\s\S]*起こした人: Claude/);
  assert.match(context, /handoff\/spec\.md/);
  assert.match(context, /本文資料/);
  assert.match(context, /不足資料（4回）/);
  assert.match(context, /検査失敗（3回）/);
  assert.match(context, /要件違い（2回）/);
  assert.doesNotMatch(context, /4位|古い理由/);
  ledger.close();
});

test('the latest send-back context includes the reason and only the first 80 detail lines', () => {
  const ledger = new Ledger(':memory:');
  const task = ledger.add({ repo: '/r/app', title: 'sendback', why: 'why', brief: 'brief' });
  const detail = Array.from({ length: 90 }, (_, index) => `detail-${index + 1}`).join('\n');
  ledger.setStatus(task.id, '走行中', `差し戻し: reason\n${detail}`);
  const context = taskContext(ledger, ledger.get(task.id)!);
  assert.match(context, /## 今回の差し戻し[\s\S]*- reason/);
  assert.match(context, /detail-1/);
  assert.match(context, /detail-80/);
  assert.doesNotMatch(context, /detail-81/);
  ledger.close();
});

test('requeued decision notes reach the worker for both Claude note forms and disappear after worker completion', () => {
  const ledger = new Ledger(':memory:');
  const task = ledger.add({ repo: '/r/app', title: 'requeue', why: 'why', brief: 'brief' });
  ledger.setStatus(task.id, '走行中', 'start', { attempts: 1 });
  ledger.setStatus(task.id, '判断待ち', 'question');
  ledger.setStatus(task.id, '待ち', '差し戻し: Claude: X');
  let context = taskContext(ledger, ledger.get(task.id)!);
  assert.match(context, /## 今回の差し戻し[\s\S]*- X/);

  ledger.setStatus(task.id, '走行中', 'start again', { attempts: 2 });
  ledger.setStatus(task.id, '判断待ち', 'question again');
  ledger.setStatus(task.id, '待ち', 'Claude: Y');
  context = taskContext(ledger, ledger.get(task.id)!);
  assert.match(context, /## 今回の差し戻し[\s\S]*- Y/);
  ledger.setStatus(task.id, '走行中', 'worker resumed', { attempts: 3 });
  ledger.setStatus(task.id, '確かめ中', 'worker finished');
  assert.doesNotMatch(taskContext(ledger, ledger.get(task.id)!), /## 今回の差し戻し/);
  ledger.close();
});

test('answer survives runOnce overwriting note and is hidden after the worker finishes', () => {
  const ledger = new Ledger(':memory:');
  const repo = '/r/app';
  const task = ledger.add({ repo, title: 'resume', why: 'why', brief: 'handoff/resume.md' });
  ledger.setStatus(task.id, '走行中', '作業開始');
  ledger.setRunner(task.id, { workdir: '/tmp/existing-copy' });
  ledger.setStatus(task.id, '判断待ち', '人の判断が必要');
  ledger.releaseRunner(task.id);
  ledger.setStatus(task.id, '待ち', '答え: 続ける');

  const deps: RunDeps = {
    start: () => 4242,
    advance: () => {},
    alive: () => true,
    load: () => 0,
  };
  runOnce(ledger, deps);
  const running = ledger.get(task.id)!;
  assert.equal(running.note, 'ハーネスが出した');
  assert.match(taskContext(ledger, running), /## 判断待ちへの答え\n続ける/);

  ledger.setStatus(task.id, '確かめ中', '作業役が終わった');
  assert.doesNotMatch(taskContext(ledger, ledger.get(task.id)!), /## 判断待ちへの答え/);
  ledger.close();
});
