import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.ts';
import { taskContext } from './context.ts';

test('task context is empty without an Issue and includes Goal, Issue, docs, and the top recent return reasons', () => {
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

  assert.equal(taskContext(ledger, unrelated, now), '');
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
