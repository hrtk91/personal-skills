// Counts Claude usage from the transcripts under ~/.claude/projects (design: handoff/claude-usage-design.md).
// Each API call is counted once, by caller (the supervisor's conversation, reviews, decision cards, the night
// watcher, consults, other `claude -p`, subagents) and, for the supervisor, by what woke it. The plan's usage
// percentages that the status line writes to limits.jsonl turn that into "tokens per percent" of the plan.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tokens = { input: number; cacheRead: number; cacheCreation: number; output: number };
/** One API call as stored in the cache. `id` is the request id (one call is written as several lines). */
type StoredRow = Tokens & { id: string; at: string; day: string; project: string; caller: string; reason: string | null; model: string };
export type UsageRow = StoredRow & { weighted: number; rawWeighted: number };
export type LimitRow = { at: string; five_hour: number | null; five_hour_resets_at: number | null; seven_day: number | null; seven_day_resets_at: number | null };
type Bucket = Tokens & { day: string; project: string; caller: string; reason: string | null; model: string; calls: number; weighted: number };

/** What a transcript has said so far, kept so that reading only the appended bytes classifies like a full read. */
type ParseState = {
  /** Caller decided by the first prompt of a non-interactive session (null until a prompt has been seen). */
  firstKind: string | null;
  /** Why the supervisor was woken: the last prompt that was not a tool result (null until one has been seen). */
  reason: string | null;
  /** True while the latest prompt is a dashboard consult message. */
  consult: boolean;
  /** Request ids of the last calls, so the lines of one call are counted once even across two reads. */
  recentIds: string[];
  startedAt: string | null;
};
type CachedFile = { size: number; malformed: number; state: ParseState; rows: StoredRow[] };
type Cache = { version: number; files: Record<string, CachedFile> };
const CACHE_VERSION = 2;

const weights = { input: 1, cacheRead: .1, cacheCreation: 1.25, output: 5 };
const modelFactor = (model: string) => /opus/i.test(model) ? 1 : /haiku/i.test(model) ? .2 : .6;
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : 0;
const str = (x: unknown) => typeof x === 'string' ? x : '';
const localDay = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE'); };
/** The text of a prompt; null for tool results (they continue the call that asked for them). */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some(x => x && typeof x === 'object' && (x as { type?: unknown }).type === 'tool_result')) return null;
  return content.map(x => x && typeof x === 'object' && (x as { type?: unknown }).type === 'text' ? str((x as { text?: unknown }).text) : '').join(' ');
}

// The opening sentences of the prompts the harness sends with `claude -p` (tools/task-ledger/*-prompt.md,
// context.ts, web/app/consult/server.ts). A review prompt may follow a short "触るファイルの外の変更" line.
export const CONSULT_SUFFIX = '返答は読みやすい文章で、必要なら短い箇条書きにしてください。台帳やファイルの変更はしないでください。';
function firstPromptKind(text: string): string {
  const head = text.slice(0, 20000);
  if (head.includes('本体に取り込む前に見るレビュー役')) return 'レビュー';
  if (head.includes('「判断待ち」を、背景を知らない持ち主が')) return '判断カード';
  if (head.includes('振り返り見張り役')) return '夜の見張り役';
  if (/^## 作業役とモデル\s*\n- worker: claude/.test(text)) return 'Claude の作業役';
  if (text.includes(CONSULT_SUFFIX)) return '相談';
  return 'その他の claude -p';
}
/** Why the supervisor was woken by this prompt; null when the line only continues what was already going on. */
export function wakeReason(text: string, meta: boolean, origin: string): string | null {
  const t = text.trimStart();
  if (origin === 'channel' || t.startsWith('<channel source="agent-channel"')) return '作業役の連絡';
  if (t.startsWith('<task-notification>')) {
    const summary = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '';
    if (summary.startsWith('Stop hook')) return t.includes('キャッシュ延命') ? 'キャッシュ延命' : 'Stop フック';
    if (summary.startsWith('Monitor event')) return /Monitor expired/.test(t) ? '見張り（expired）' : '見張り（Monitor）';
    if (summary.startsWith('Monitor ')) return '見張り（Monitor）';
    if (summary.startsWith('Agent ')) return 'サブエージェントの終わり';
    return '裏の命令の終わり';
  }
  if (origin === 'peer' || t.startsWith('Another Claude session sent')) return '別の会話からの連絡';
  if (/^(夜間?の)?見回り|^【1 時間ごとの確かめ/.test(t)) return '見回り';
  if (/^(夜|朝)の報告を作る/.test(t)) return '朝夕の報告';
  // Lines Claude Code adds by itself (skill bodies, images, the summary after /compact, usage-limit notes) carry on.
  if (meta || t.startsWith('This session is being continued') || t.startsWith('<local-command-stdout>') || t.startsWith('[Request interrupted')) return null;
  return 'あなたの発言';
}
function projectName(cwd: string): string {
  const match = cwd.match(/\/\.cache\/herdr-([^/]+)\/wt\/[^/]+/);
  return match ? match[1]! : cwd;
}
const freshState = (): ParseState => ({ firstKind: null, reason: null, consult: false, recentIds: [], startedAt: null });
// Only these lines are parsed; the rest (request blobs, attachments, …) are most of the bytes and say nothing here.
const WANTED = ['"type":"assistant"', '"type":"user"', '"type":"queue-operation"'];

/** Reads complete lines of a transcript, continuing from `state`. Mutates `state`. */
function parseLines(text: string, file: string, state: ParseState): { rows: StoredRow[]; malformed: number } {
  const rows: StoredRow[] = []; let malformed = 0;
  const subagentFile = file.includes('/subagents/');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!WANTED.some(w => trimmed.includes(w))) { if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) malformed++; continue; }
    let e: any; try { e = JSON.parse(trimmed); } catch { malformed++; continue; }
    if (!state.startedAt && typeof e.timestamp === 'string') state.startedAt = e.timestamp;
    if (e.type === 'queue-operation') {
      if (e.operation === 'enqueue' && state.firstKind === null && typeof e.content === 'string' && e.content.trim()) state.firstKind = firstPromptKind(e.content);
      continue;
    }
    if (e.type === 'user') {
      if (e.toolUseResult !== undefined) continue;
      const value = promptText(e.message?.content);
      if (value === null || !value.trim()) continue;
      const meta = e.isMeta === true, origin = str(e.origin?.kind);
      if (state.firstKind === null && !meta) state.firstKind = firstPromptKind(value);
      const reason = wakeReason(value, meta, origin);
      if (reason !== null) { state.reason = reason; state.consult = value.includes(CONSULT_SUFFIX); }
      continue;
    }
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const id = str(e.requestId) || str(e.message.id) || str(e.uuid);
    if (id && state.recentIds.includes(id)) continue;
    if (id) { state.recentIds.push(id); if (state.recentIds.length > 64) state.recentIds.shift(); }
    const usage = e.message.usage, at = str(e.timestamp);
    // `claude -p` writes entrypoint "sdk-cli"; the interactive session writes "cli".
    const interactive = !str(e.entrypoint).startsWith('sdk');
    const caller = e.isSidechain === true || subagentFile ? 'サブエージェント'
      : interactive ? '司令塔'
      : state.consult ? '相談'
      : state.firstKind ?? 'その他の claude -p';
    rows.push({
      id, at, day: localDay(at), project: projectName(str(e.cwd) || file), caller,
      reason: caller === '司令塔' ? state.reason ?? 'あなたの発言' : null, model: str(e.message.model),
      input: num(usage.input_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheCreation: num(usage.cache_creation_input_tokens), output: num(usage.output_tokens),
    });
  }
  return { rows, malformed };
}
/**
 * Hands the complete lines in bytes [from, size) to `onText`, a few megabytes at a time (the supervisor's transcript
 * is over 100 MB), and returns where the read stopped: after the last newline, so a line still being written is
 * read next time.
 */
function readNewLines(file: string, from: number, size: number, onText: (text: string) => void): number {
  const handle = openSync(file, 'r'); let pos = from, chunk = 8 << 20;
  try {
    while (pos < size) {
      const length = Math.min(chunk, size - pos), buffer = Buffer.alloc(length);
      let got = 0; while (got < length) { const n = readSync(handle, buffer, got, length - got, pos + got); if (!n) break; got += n; }
      const end = buffer.subarray(0, got).lastIndexOf(10) + 1;
      if (!end) { if (pos + got >= size) break; chunk *= 2; continue; } // one line longer than the chunk
      onText(buffer.subarray(0, end).toString('utf8')); pos += end;
    }
  } finally { closeSync(handle); }
  return pos;
}
const withWeights = (r: StoredRow): UsageRow => {
  const rawWeighted = r.input * weights.input + r.cacheRead * weights.cacheRead + r.cacheCreation * weights.cacheCreation + r.output * weights.output;
  return { ...r, rawWeighted, weighted: rawWeighted * modelFactor(r.model) };
};

/** The q-quantile, interpolating between the two nearest values (the median of two values is their mean). */
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
function leastSquares(rows: Array<{ raw: Tokens; delta: number }>): Tokens | null {
  const keys = ['input', 'cacheRead', 'cacheCreation', 'output'] as const;
  const m = keys.map(a => keys.map(b => rows.reduce((s, r) => s + r.raw[a] * r.raw[b], 0))), v = keys.map(a => rows.reduce((s, r) => s + r.raw[a] * r.delta, 0));
  for (let i = 0; i < 4; i++) {
    let p = i; for (let j = i + 1; j < 4; j++) if (Math.abs(m[j]![i]!) > Math.abs(m[p]![i]!)) p = j;
    if (Math.abs(m[p]![i]!) < 1e-12) return null;
    [m[i], m[p]] = [m[p]!, m[i]!]; [v[i], v[p]] = [v[p]!, v[i]!];
    const d = m[i]![i]!; for (let k = i; k < 4; k++) m[i]![k] = m[i]![k]! / d; v[i] = v[i]! / d;
    for (let j = 0; j < 4; j++) { if (j === i) continue; const f = m[j]![i]!; for (let k = i; k < 4; k++) m[j]![k] = m[j]![k]! - f * m[i]![k]!; v[j] = v[j]! - f * v[i]!; }
  }
  return { input: v[0]!, cacheRead: v[1]!, cacheCreation: v[2]!, output: v[3]! };
}

type Observation = { t: number; value: number; window: number; rose: boolean };
/**
 * The plan's percentage over time, one window (same reset time) after another. Several sessions write their own,
 * sometimes older, copy of the percentage (10/30: 23→22→23 within two seconds), and within one window the real
 * value never goes down — so a row below the highest value seen so far is a stale copy and does not move the
 * value, and a row whose reset time belongs to an earlier window is ignored. `rose` marks the moments the value
 * went up while it was being watched (the first row of a window is not one: when it got there is unknown).
 */
function observations(limits: LimitRow[], key: 'five_hour' | 'seven_day'): Observation[] {
  const resetKey = `${key}_resets_at` as const, slack = 3600, out: Observation[] = [];
  let window = -Infinity, max = -Infinity;
  for (const row of [...limits].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const value = row[key], resets = row[resetKey], t = Date.parse(row.at);
    if (value === null || resets === null || Number.isNaN(t)) continue;
    if (resets < window - slack) continue;
    if (resets > window + slack) { window = resets; max = -Infinity; } else window = Math.max(window, resets);
    const rose = value > max && max !== -Infinity;
    if (value > max) max = value;
    out.push({ t, value: max, window, rose });
  }
  return out;
}
/** Tokens per percent: between two moments the percentage went up (same window), all calls in between. */
function capacity(limits: LimitRow[], rows: UsageRow[], key: 'five_hour' | 'seven_day', from: number, to: number) {
  const rises = observations(limits, key).filter(o => o.rose);
  const sorted = rows.map(r => ({ t: Date.parse(r.at), r })).filter(x => !Number.isNaN(x.t)).sort((a, b) => a.t - b.t);
  const firstAfter = (t: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]!.t <= t) lo = mid + 1; else hi = mid; } return lo; };
  const intervals: Array<{ delta: number; tokens: number; unpriced: number; raw: Tokens; from: string; to: string }> = [];
  for (let i = 1; i < rises.length; i++) {
    const a = rises[i - 1]!, b = rises[i]!;
    if (a.window !== b.window || a.t < from || b.t > to) continue;
    const raw: Tokens = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }; let tokens = 0, unpriced = 0;
    for (let j = firstAfter(a.t); j < sorted.length && sorted[j]!.t <= b.t; j++) {
      const r = sorted[j]!.r; raw.input += r.input; raw.cacheRead += r.cacheRead; raw.cacheCreation += r.cacheCreation; raw.output += r.output; tokens += r.weighted; unpriced += r.rawWeighted;
    }
    intervals.push({ delta: b.value - a.value, tokens, unpriced, raw, from: new Date(a.t).toISOString(), to: new Date(b.t).toISOString() });
  }
  const totalPct = intervals.reduce((s, x) => s + x.delta, 0), totalTokens = intervals.reduce((s, x) => s + x.tokens, 0), totalUnpriced = intervals.reduce((s, x) => s + x.unpriced, 0);
  const per = intervals.map(x => x.tokens / x.delta), perUnpriced = intervals.map(x => x.unpriced / x.delta);
  const perPercent = totalPct ? totalTokens / totalPct : null, perPercentUnpriced = totalPct ? totalUnpriced / totalPct : null;
  return {
    intervals: intervals.length, percentPoints: totalPct,
    perPercent, capacity100: perPercent === null ? null : perPercent * 100,
    medianPerPercent: quantile(per, .5), rangePerPercent: { low: quantile(per, .25), high: quantile(per, .75) },
    weightedWithModelPrices: perPercent, weightedWithoutModelPrices: perPercentUnpriced,
    medianPerPercentWithoutModelPrices: quantile(perUnpriced, .5),
    capacity100WithModelPrices: perPercent === null ? null : perPercent * 100, capacity100WithoutModelPrices: perPercentUnpriced === null ? null : perPercentUnpriced * 100,
    coefficients: intervals.length >= 20 ? leastSquares(intervals) : null,
    spans: intervals.map(({ from, to, delta, tokens }) => ({ from, to, delta, tokens })),
  };
}
/** The seven-day percentage now, and when it runs out at the pace of the last 24 hours (null if not before the reset). */
function remainingOf(limits: LimitRow[], now: number) {
  const seen = observations(limits.filter(x => Date.parse(x.at) <= now), 'seven_day');
  const latest = seen.at(-1); if (!latest) return null;
  // Only the current window: a row from before the reset says nothing about this week's pace.
  const recent = seen.filter(o => o.window === latest.window && o.t >= now - 86400000), first = recent[0];
  const rate = first && latest.t > first.t ? (latest.value - first.value) / (latest.t - first.t) : null;
  const exhaust = rate && rate > 0 ? latest.t + (100 - latest.value) / rate : null;
  return {
    sevenDay: latest.value, sevenDayResetsAt: latest.window, observedAt: new Date(latest.t).toISOString(),
    pacePerHour: rate === null ? null : rate * 3600000, paceSince: first ? new Date(first.t).toISOString() : null,
    exhaustAt: exhaust !== null && exhaust < latest.window * 1000 ? new Date(exhaust).toISOString() : null,
  };
}

export function getClaudeUsage(days = 7, now = Date.now()) {
  if (process.env.NODE_TEST_CONTEXT && (!process.env.CLAUDE_PROJECTS_DIR || !process.env.CLAUDE_USAGE_DIR)) {
    throw new Error('claudeUsage tests must set CLAUDE_PROJECTS_DIR and CLAUDE_USAGE_DIR to temporary directories');
  }
  const transcriptDir = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects');
  const usageDir = process.env.CLAUDE_USAGE_DIR ?? join(homedir(), '.local/share/claude-usage'), cachePath = join(usageDir, 'transcript-usage.json');
  let cache: Cache = { version: CACHE_VERSION, files: {} };
  try { const loaded = JSON.parse(readFileSync(cachePath, 'utf8')); if (loaded?.version === CACHE_VERSION && loaded.files) cache = loaded; } catch {}
  const fileList: string[] = [];
  const walk = (dir: string) => { let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith('.jsonl')) fileList.push(p); } };
  walk(transcriptDir);
  let changed = false;
  for (const file of fileList) {
    let size = 0; try { size = statSync(file).size; } catch { continue; }
    let entry = cache.files[file];
    if (entry && size === entry.size) continue;
    // A shorter file was rewritten: read it again from the start.
    if (!entry || size < entry.size) { entry = cache.files[file] = { size: 0, malformed: 0, state: freshState(), rows: [] }; changed = true; }
    const current = entry;
    try {
      const end = readNewLines(file, current.size, size, text => {
        const parsed = parseLines(text, file, current.state);
        for (const r of parsed.rows) current.rows.push(r);
        current.malformed += parsed.malformed;
      });
      if (end !== current.size) { current.size = end; changed = true; }
    } catch { delete cache.files[file]; changed = true; } // read it whole next time rather than count a part twice
  }
  const listed = new Set(fileList);
  for (const file of Object.keys(cache.files)) if (!listed.has(file)) { delete cache.files[file]; changed = true; }
  if (changed) { mkdirSync(usageDir, { recursive: true }); const tmp = `${cachePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, cachePath); }

  // A forked session (`--fork-session`, a forked subagent) copies earlier calls into its own file: count each call
  // once, in the file that started first.
  const files = Object.values(cache.files).sort((a, b) => (a.state.startedAt ?? '').localeCompare(b.state.startedAt ?? ''));
  const seen = new Set<string>(), rows: UsageRow[] = [];
  let malformed = 0;
  for (const f of files) { malformed += f.malformed; for (const r of f.rows) { if (r.id) { if (seen.has(r.id)) continue; seen.add(r.id); } rows.push(withWeights(r)); } }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const cutoff = now - days * 86400000, recent = rows.filter(r => { const t = Date.parse(r.at); return t >= cutoff && t <= now; });

  const limitsPath = join(usageDir, 'limits.jsonl'); let limits: LimitRow[] = [];
  if (existsSync(limitsPath)) {
    try {
      limits = readFileSync(limitsPath, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => {
        try { const x = JSON.parse(l); if (typeof x?.at !== 'string') throw new Error('no time'); return [{ at: x.at, five_hour: x.five_hour ?? null, five_hour_resets_at: x.five_hour_resets_at ?? null, seven_day: x.seven_day ?? null, seven_day_resets_at: x.seven_day_resets_at ?? null }]; }
        catch { malformed++; return []; }
      });
    } catch {}
  }
  const byKey = new Map<string, Bucket>();
  for (const r of recent) {
    const key = `${r.day}\t${r.project}\t${r.caller}\t${r.reason ?? ''}\t${r.model}`;
    let v = byKey.get(key);
    if (!v) { v = { day: r.day, project: r.project, caller: r.caller, reason: r.reason, model: r.model, calls: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0, weighted: 0 }; byKey.set(key, v); }
    v.calls++; v.input += r.input; v.cacheRead += r.cacheRead; v.cacheCreation += r.cacheCreation; v.output += r.output; v.weighted += r.weighted;
  }
  // Both windows are estimated from the intervals of the last seven days (design: 直近 7 日分).
  const from = now - 7 * 86400000;
  return {
    days, rows: [...byKey.values()], events: recent, malformedLines: malformed,
    remaining: limits.length ? remainingOf(limits, now) : null,
    capacity: { sevenDay: capacity(limits, rows, 'seven_day', from, now), fiveHour: capacity(limits, rows, 'five_hour', from, now) },
  };
}

const fmt = (n: number | null | undefined) => n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US');
export function renderClaudeUsage(result: ReturnType<typeof getClaudeUsage>): string {
  const totals = new Map<string, number>(); for (const r of result.rows) totals.set(r.day, (totals.get(r.day) ?? 0) + r.weighted);
  const top = new Map<string, number>(); for (const r of result.rows) { const k = `${r.caller}・${r.reason ?? '—'}`; top.set(k, (top.get(k) ?? 0) + r.weighted); }
  const rem = result.remaining, cap = (name: string, c: ReturnType<typeof getClaudeUsage>['capacity']['sevenDay']) =>
    `${name}: 1% あたり ${fmt(c.perPercent)}（真ん中 ${fmt(c.medianPerPercent)}、幅 ${fmt(c.rangePerPercent.low)}〜${fmt(c.rangePerPercent.high)}、モデルの値段の比を掛けない値 ${fmt(c.weightedWithoutModelPrices)}）、100% ${fmt(c.capacity100)}、区間 ${c.intervals}`
      + (c.coefficients ? `、係数 input ${c.coefficients.input.toExponential(2)} cache_read ${c.coefficients.cacheRead.toExponential(2)} cache_creation ${c.coefficients.cacheCreation.toExponential(2)} output ${c.coefficients.output.toExponential(2)}` : '');
  return [
    '日\t換算値', ...[...totals].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => `${d}\t${fmt(n)}`), '',
    '上位 呼び手・理由\t換算値', ...[...top].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}\t${fmt(n)}`), '',
    rem ? `7 日の枠: ${rem.sevenDay}%（リセット ${new Date(rem.sevenDayResetsAt * 1000).toLocaleString('sv-SE')}）、直近のペース ${rem.pacePerHour === null ? '—' : rem.pacePerHour.toFixed(2)}%/時、尽きる見込み ${rem.exhaustAt ? new Date(rem.exhaustAt).toLocaleString('sv-SE') : 'リセットまで持つ'}` : '7 日の枠: 記録なし',
    cap('容量の推定（7 日）', result.capacity.sevenDay), cap('容量の推定（5 時間）', result.capacity.fiveHour),
    `壊れた行: ${result.malformedLines}`,
  ].join('\n');
}
