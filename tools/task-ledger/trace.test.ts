if (process.env.TASK_DECISION_SPAWN === undefined) process.env.TASK_DECISION_SPAWN = "/bin/true";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.ts';
import { buildTrace, renderTrace, report, toOtlp } from './trace.ts';

// A clock the test moves by hand, so every span has a known length.
function clock() {
  let now = Date.parse('2026-10-28T00:00:00Z');
  return { now: () => new Date(now), wait: (minutes: number) => { now += minutes * 60_000; } };
}

function finishedTask() {
  const time = clock();
  const ledger = new Ledger(':memory:', time.now);
  const task = ledger.add({ repo: '/r', title: '掛け算を足す', why: 'test', brief: 'handoff/t.md' });
  time.wait(5); ledger.setStatus(task.id, '走行中', '出した', { attempts: 1 });
  time.wait(30); ledger.setStatus(task.id, '確かめ中', '作業役が終わった');
  ledger.recordSpan({ task_id: task.id, attempt: 1, name: '確かめ', start: time.now().toISOString(), end: new Date(time.now().getTime() + 4 * 60_000).toISOString(), ok: false, attributes: { 'step.exit_code': 1 } });
  time.wait(4); ledger.setStatus(task.id, '走行中', '差し戻し: 確かめのコマンド `npm test` が落ちた', { attempts: 2 });
  time.wait(20); ledger.setStatus(task.id, '確かめ中', '作業役が終わった');
  time.wait(4); ledger.setStatus(task.id, 'レビュー中', '確かめが通った');
  ledger.recordSpan({ task_id: task.id, attempt: 2, name: 'レビュー', start: time.now().toISOString(), end: new Date(time.now().getTime() + 3 * 60_000).toISOString(), ok: true, attributes: { 'review.verdict': '通す', 'review.cost_usd': 0.5, 'review.output_tokens': 1200 } });
  time.wait(3); ledger.setStatus(task.id, '取り込み中', 'レビュー: 通す');
  time.wait(2); ledger.setStatus(task.id, '済', '取り込んだ');
  time.wait(60);
  return { ledger, task: ledger.get(task.id)!, time };
}

test('a finished task becomes one trace: the task, each status it passed, and the harness steps inside them', () => {
  const { ledger, task, time } = finishedTask();
  const trace = buildTrace(ledger, task, time.now());
  const root = trace.spans[0]!;
  assert.equal(root.role, 'task');
  assert.equal(root.end - root.start, 68 * 60_000, 'ends when the task was finished, not now');
  assert.equal(root.open, false);
  assert.deepEqual(trace.spans.filter((s) => s.role === 'status').map((s) => s.name), ['待ち', '走行中', '確かめ中', '走行中', '確かめ中', 'レビュー中', '取り込み中']);
  const firstCheck = trace.spans.find((s) => s.role === 'status' && s.name === '確かめ中')!;
  assert.equal(firstCheck.ok, true);
  assert.match(String(firstCheck.attributes['status.left_because']), /^差し戻し/);
  const step = trace.spans.find((s) => s.name === '確かめ' && s.role === 'step')!;
  assert.equal(step.parentSpanId, firstCheck.spanId, 'a step sits under the status it ran in');
  assert.equal(step.ok, false);
  const second = trace.spans.filter((s) => s.role === 'status' && s.name === '走行中')[1]!;
  assert.equal(second.attributes['task.attempt'], 2);
  assert.equal(new Set(trace.spans.map((s) => s.traceId)).size, 1);
  assert.equal(buildTrace(ledger, task, time.now()).spans[0]!.traceId, root.traceId, 'the same task always gets the same trace id');
});

test('a task still in a status has that status and the task open until now', () => {
  const time = clock();
  const ledger = new Ledger(':memory:', time.now);
  const task = ledger.add({ repo: '/r', title: 't', why: 'w', brief: 'b.md' });
  time.wait(10); ledger.setStatus(task.id, '走行中', '出した');
  time.wait(15);
  const trace = buildTrace(ledger, ledger.get(task.id)!, time.now());
  const running = trace.spans.find((s) => s.name === '走行中')!;
  assert.equal(running.open, true);
  assert.equal(running.end - running.start, 15 * 60_000);
  assert.equal(trace.spans[0]!.open, true);
});

test('cleanup tab and reason are readable in the rendered trace', () => {
  const { ledger, task, time } = finishedTask();
  try {
    ledger.recordSpan({ task_id: task.id, attempt: 1, name: '片付け', start: time.now().toISOString(), end: time.now().toISOString(), ok: true,
      attributes: { 'cleanup.tab_id': 'w1:t2', 'cleanup.reason': '済から10分経過' } });
    const text = renderTrace(buildTrace(ledger, ledger.get(task.id)!, time.now())).join('\n');
    assert.match(text, /片付け.*tab=w1:t2 reason=済から10分経過/);
  } finally { ledger.close(); }
});

test('the OTLP document has the resource, nanosecond times, typed attributes and parent links', () => {
  const { ledger, task, time } = finishedTask();
  const doc = toOtlp([buildTrace(ledger, task, time.now())]) as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue: string } }[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
  assert.equal(doc.resourceSpans[0]!.resource.attributes[0]!.value.stringValue, 'task-ledger');
  const spans = doc.resourceSpans[0]!.scopeSpans[0]!.spans;
  const review = spans.find((s) => s.name === 'レビュー')! as { startTimeUnixNano: string; endTimeUnixNano: string; parentSpanId: string; attributes: { key: string; value: Record<string, unknown> }[]; status: { code: number } };
  assert.equal(BigInt(review.endTimeUnixNano) - BigInt(review.startTimeUnixNano), 3n * 60n * 1_000_000_000n);
  assert.deepEqual(review.attributes.find((a) => a.key === 'review.cost_usd')!.value, { doubleValue: 0.5 });
  assert.deepEqual(review.attributes.find((a) => a.key === 'review.output_tokens')!.value, { intValue: '1200' });
  assert.equal(review.status.code, 1);
  assert.ok(spans.some((s) => s.spanId === review.parentSpanId && s.name === 'レビュー中'));
});

test('the report counts work returned because its report said conditions were unmet', () => {
  const time = clock();
  const ledger = new Ledger(':memory:', time.now);
  const task = ledger.add({ repo: '/r', title: '未完了', why: 'w', brief: 'handoff/t.md' });
  ledger.setStatus(task.id, '確かめ中');
  time.wait(1);
  ledger.setStatus(task.id, '走行中', '差し戻し: 作業役の報告が、終わりの条件を満たしていないと書いている: 条件X', { attempts: 2 });
  const text = report([buildTrace(ledger, ledger.get(task.id)!, time.now())]).join('\n');
  assert.match(text, /作業役が未完了と書いていた\s+1 回/);
  assert.ok(renderTrace(buildTrace(ledger, ledger.get(task.id)!, time.now())).some((line) => line.includes('報告を見る')) === false);
  ledger.close();
});

test('the report gives times per status and step, why work went back, and the review cost', () => {
  const { ledger, task, time } = finishedTask();
  const trace = buildTrace(ledger, task, time.now());
  const text = report([trace]).join('\n');
  assert.match(text, /状態: 走行中\s+20 分\s+30 分\s+2 回/);
  assert.match(text, /段: 確かめ\s+4 分/);
  assert.match(text, /確かめが落ちて差し戻し\s+1 回/);
  assert.match(text, /1 回、合計 \$0\.50、出力 1200 トークン/);
  assert.ok(renderTrace(trace).some((line) => /✗\s+確かめ\s+run|✗\s+確かめ/.test(line)));
});
