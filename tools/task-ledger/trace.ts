// Traces of ledger tasks in the OpenTelemetry (OTLP JSON) shape: one trace per task, one span per status the task
// passed through (from the events table), and under those the harness's own steps (from the spans table).
// Nothing is sent anywhere; the files can be handed to a viewer later. Design: handoff/task-ledger-trace-design.md
import { createHash } from 'node:crypto';
import { type Event, type Ledger, type Span, type SpanAttributes, type Task } from './ledger.ts';

export type TraceSpan = {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  start: number; end: number; ok: boolean; open: boolean; attributes: SpanAttributes; depth: number; role: 'task' | 'status' | 'step';
};
export type TaskTrace = { task: Task; spans: TraceSpan[] };

const CLOSED = new Set(['済', 'やめ']);

function hex(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** Builds a task's trace. A status the task is still in ends at `now` and is marked open. */
export function buildTrace(ledger: Ledger, task: Task, now: Date = new Date()): TaskTrace {
  const traceId = hex(task.id, 32);
  const events = ledger.events(task.id);
  const closedAt = CLOSED.has(task.status) ? Date.parse(events.at(-1)?.at ?? task.updated_at) : null;
  const steps = ledger.spans(task.id);
  const lastStep = steps.reduce((latest, step) => Math.max(latest, Date.parse(step.end)), 0);
  const end = closedAt === null ? now.getTime() : Math.max(closedAt, lastStep);
  const rootId = hex(`${task.id}/root`, 16);
  const spans: TraceSpan[] = [{
    traceId, spanId: rootId, name: task.title, start: Date.parse(task.created_at), end, ok: task.status !== 'やめ' && task.status !== '判断待ち',
    open: closedAt === null, depth: 0, role: 'task',
    attributes: { 'task.id': task.id, 'task.repo': task.repo, 'task.status': task.status, 'task.attempts': task.attempts, 'task.kind': task.kind },
  }];
  const states = statusSpans(task, events, traceId, rootId, end, closedAt === null);
  spans.push(...states);
  for (const step of steps) spans.push(stepSpan(task, step, traceId, states, rootId));
  spans.sort((a, b) => a.start - b.start || a.depth - b.depth);
  return { task, spans };
}

function statusSpans(task: Task, events: Event[], traceId: string, rootId: string, end: number, open: boolean): TraceSpan[] {
  const out: TraceSpan[] = [];
  let attempt = 0;
  events.forEach((event, index) => {
    if (event.to_status === '走行中') attempt += 1;
    if (CLOSED.has(event.to_status)) return;
    const next = events[index + 1];
    const start = Date.parse(event.at);
    out.push({
      traceId, spanId: hex(`${task.id}/status/${index}`, 16), parentSpanId: rootId, name: event.to_status,
      start, end: next ? Date.parse(next.at) : end, open: !next && open, depth: 1, role: 'status',
      ok: next ? next.to_status !== '判断待ち' && next.to_status !== 'やめ' : event.to_status !== '判断待ち',
      attributes: {
        'task.attempt': Math.max(attempt, 1),
        ...(event.note ? { 'status.note': event.note } : {}),
        ...(next?.note ? { 'status.left_because': next.note } : {}),
      },
    });
  });
  return out;
}

function stepSpan(task: Task, step: Span, traceId: string, states: TraceSpan[], rootId: string): TraceSpan {
  const start = Date.parse(step.start);
  // The status the harness was in when the step began holds it.
  const parent = [...states].reverse().find((state) => state.start <= start && start <= state.end);
  return {
    traceId, spanId: hex(`${task.id}/step/${step.name}/${step.start}`, 16), parentSpanId: parent?.spanId ?? rootId,
    name: step.name, start, end: Date.parse(step.end), ok: step.ok, open: false, depth: parent ? 2 : 1, role: 'step',
    attributes: { 'task.attempt': step.attempt, ...step.attributes },
  };
}

function otlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

function nanos(ms: number): string {
  return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

/** The traces as one OTLP JSON document (resourceSpans → scopeSpans → spans), as the OTLP/HTTP JSON exporter writes it. */
export function toOtlp(traces: TaskTrace[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'task-ledger' } }] },
      scopeSpans: [{
        scope: { name: 'task-ledger' },
        spans: traces.flatMap((trace) => trace.spans.map((span) => ({
          traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name, kind: 1, startTimeUnixNano: nanos(span.start), endTimeUnixNano: nanos(span.end),
          attributes: Object.entries({ ...span.attributes, ...(span.open ? { 'span.open': true } : {}) }).map(([key, value]) => ({ key, value: otlpValue(value) })),
          status: { code: span.ok ? 1 : 2 },
        }))),
      }],
    }],
  };
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** One task's trace as indented lines: when each part began (from the task's start), how long it took, and why it ended. */
export function renderTrace(trace: TaskTrace): string[] {
  const origin = trace.spans[0]!.start;
  return trace.spans.map((span) => {
    const at = duration(span.start - origin).padStart(10);
    const took = `${duration(span.end - span.start)}${span.open ? '〜' : ''}`.padStart(11);
    const mark = span.ok ? ' ' : '✗';
    const facts = Object.entries(span.attributes)
      .filter(([key]) => !['task.id', 'task.repo', 'status.note'].includes(key))
      .map(([key, value]) => `${key.replace(/^cleanup\.tab_id$/, 'tab').replace(/^cleanup\.reason$/, 'reason').replace(/^(task|status|step|review)\./, '')}=${typeof value === 'string' ? clip(value, 90) : value}`);
    return `${at} ${took} ${mark} ${'  '.repeat(span.depth)}${span.name}${facts.length ? `  ${facts.join(' ')}` : ''}`;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
}

/** How long each status and step takes across tasks, why work goes back to the worker, and what the reviews cost. */
export function report(traces: TaskTrace[]): string[] {
  const out: string[] = [];
  const byName = new Map<string, number[]>();
  for (const span of traces.flatMap((trace) => trace.spans.filter((s) => s.role !== 'task' && !s.open))) {
    const key = span.role === 'status' ? `状態: ${span.name}` : `段: ${span.name}`;
    byName.set(key, [...(byName.get(key) ?? []), span.end - span.start]);
  }
  out.push(`仕事 ${traces.length} 件（済 ${traces.filter((t) => t.task.status === '済').length}・判断待ち ${traces.filter((t) => t.task.status === '判断待ち').length}）`);
  out.push('', '## かかった時間（中央値・最大・回数）');
  for (const [name, values] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`${name.padEnd(16)} ${duration(median(values)).padStart(12)} ${duration(Math.max(...values)).padStart(12)} ${String(values.length).padStart(4)} 回`);
  }
  const reasons = new Map<string, number>();
  for (const trace of traces) {
    for (const span of trace.spans) {
      const why = span.attributes['status.left_because'];
      if (span.role !== 'status' || typeof why !== 'string') continue;
      if (!/^差し戻し|判断待ち|落ち|戻した|通らなかった/.test(why) && span.ok) continue;
      const kind = why.startsWith('差し戻し: 作業役の報告が') ? '作業役が未完了と書いていた'
        : why.startsWith('差し戻し: レビュー') ? 'レビューで差し戻し'
        : why.startsWith('差し戻し: 確かめ') ? '確かめが落ちて差し戻し'
        : why.startsWith('差し戻し') ? 'その他の差し戻し'
        : /本体に入れたあとの確かめ/.test(why) ? '取り込み後の確かめが落ちた'
        : /回やって通らなかった/.test(why) ? '回数を使い切った'
        : /消えた/.test(why) ? '進めていたプロセスが消えた'
        : null;
      if (kind) reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
    }
  }
  out.push('', '## 戻った・止まった理由');
  if (reasons.size === 0) out.push('なし');
  for (const [kind, count] of [...reasons].sort((a, b) => b[1] - a[1])) out.push(`${kind.padEnd(20)} ${count} 回`);
  const reviews = traces.flatMap((trace) => trace.spans.filter((span) => typeof span.attributes['review.cost_usd'] === 'number'));
  out.push('', '## レビュー（Opus）');
  if (reviews.length === 0) out.push('費用の記録なし（記録を付け始める前の仕事だけ）');
  else {
    const cost = reviews.reduce((sum, span) => sum + Number(span.attributes['review.cost_usd']), 0);
    const tokens = reviews.reduce((sum, span) => sum + Number(span.attributes['review.output_tokens'] ?? 0), 0);
    out.push(`${reviews.length} 回、合計 $${cost.toFixed(2)}、出力 ${tokens} トークン`);
  }
  return out;
}

/** Tasks whose last change is on or after `since` (all tasks when it is missing). */
export function tracesSince(ledger: Ledger, since: Date | null, repo?: string, now: Date = new Date()): TaskTrace[] {
  return ledger.list({ repo, all: true })
    .filter((task) => !since || Date.parse(task.updated_at) >= since.getTime())
    .map((task) => buildTrace(ledger, task, now));
}
