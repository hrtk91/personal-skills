import { appendFileSync, existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type Kind = 'finish' | 'post' | 'say' | 'stopped';
export type Fact = { claim: string; how: string };
export type Row = {
  id: string; at: string; from: string; to: string; kind: Kind; body: string;
  refs: string[]; reply_to: string | null; fields: Record<string, unknown>;
};
export type Input = {
  kind: Kind; from: string; to?: string; body: string; refs?: string[];
  reply_to?: string | null; fields?: Record<string, unknown>; facts?: Fact[];
};
export type Filter = { from?: string; to?: string; kind?: Kind; after?: string };
export type ReadResult = { rows: Row[]; skipped: number };

let lastTimestamp = 0;
let sequence = 0;
const kinds = new Set<Kind>(['finish', 'post', 'say', 'stopped']);

export function supervisorName(
  parentPid: (pid: number) => number | null = procParentPid,
  processInfo: (pid: number) => { comm: string; args: string[] } | null = procProcessInfo,
): string {
  let pid = processInfo(process.pid) ? parentPid(process.pid) : null;
  const visited = new Set<number>();
  while (pid && pid > 1 && !visited.has(pid)) {
    visited.add(pid);
    const info = processInfo(pid);
    if (!info) break;
    const executable = info.args[0]?.split('/').at(-1) ?? '';
    if (/^claude/i.test(info.comm) || /^claude/i.test(executable)) return `claude-${pid}`;
    pid = parentPid(pid);
  }
  return 'claude';
}

function procParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    try {
      const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const parent = Number(output);
      return Number.isInteger(parent) ? parent : null;
    } catch { return null; }
  }
}

function procProcessInfo(pid: number): { comm: string; args: string[] } | null {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return { comm, args };
  } catch {
    try {
      const output = execFileSync('ps', ['-o', 'comm=,args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const [comm = '', ...args] = output.split(/\s+/);
      return { comm, args };
    } catch { return null; }
  }
}

export function logPath(): string {
  return process.env.AGENT_CHANNEL || join(homedir(), '.cache', 'agent-channel', 'channel.jsonl');
}

function makeId(now: number): string {
  if (now > lastTimestamp) { lastTimestamp = now; sequence = 0; }
  else sequence += 1;
  return `${new Date(now).toISOString()}-${String(sequence).padStart(6, '0')}-${randomBytes(4).toString('hex')}`;
}

export function append(log: string, input: Input): Row {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  if (!kinds.has(input.kind)) throw new Error('kind must be finish, post, say, or stopped');
  if (typeof input.from !== 'string' || !input.from.trim()) throw new Error('from is required');
  if (typeof input.body !== 'string') throw new Error('body must be a string');
  if (input.kind === 'say' && (typeof input.to !== 'string' || !input.to.trim())) throw new Error('say requires to');
  if (input.to !== undefined && (typeof input.to !== 'string' || !input.to.trim())) throw new Error('to must be a non-empty string');
  const refs = input.refs ?? [];
  if (!Array.isArray(refs) || !refs.every((v) => typeof v === 'string')) throw new Error('refs must be an array of strings');
  const fields = input.fields ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object');
  let finalFields: Record<string, unknown> = { ...fields };
  if (input.kind === 'finish') {
    const facts = input.facts ?? fields.facts ?? [];
    if (!Array.isArray(facts) || !facts.every((f) => f && typeof f.claim === 'string' && typeof f.how === 'string'))
      throw new Error('finish facts must be an array of { claim, how }');
    finalFields = { ...fields, facts };
  } else if (input.facts !== undefined) throw new Error('facts are only valid for finish');
  const row: Row = {
    id: makeId(Date.now()), at: new Date().toISOString(), from: input.from,
    to: input.to ?? (input.kind === 'say' ? '' : 'claude'), kind: input.kind, body: input.body,
    refs: [...refs], reply_to: input.reply_to ?? null, fields: finalFields,
  };
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  return row;
}

function matches(row: Row, filter: Filter): boolean {
  return (!filter.from || row.from === filter.from) && (!filter.to || row.to === filter.to || row.to === '*') &&
    (!filter.kind || row.kind === filter.kind);
}

export function read(log: string, filter: Filter = {}): ReadResult {
  if (!existsSync(log)) return { rows: [], skipped: 0 };
  const content = readFileSync(log, 'utf8');
  const complete = content.endsWith('\n') ? content.slice(0, -1) : content.slice(0, content.lastIndexOf('\n'));
  if (!complete) return { rows: [], skipped: 0 };
  const lines = complete.split('\n');
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.id !== 'string' || typeof value.at !== 'string' ||
        typeof value.from !== 'string' || typeof value.to !== 'string' || !kinds.has(value.kind) ||
        typeof value.body !== 'string' || !Array.isArray(value.refs) || !value.refs.every((ref: unknown) => typeof ref === 'string') ||
        !(value.reply_to === null || typeof value.reply_to === 'string') ||
        !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) { skipped++; continue; }
      rows.push(value as Row);
    } catch { skipped++; }
  }
  let afterRows = rows;
  if (filter.after) {
    const anchorIndex = rows.findIndex((row) => row.id === filter.after);
    if (anchorIndex >= 0) afterRows = rows.slice(anchorIndex + 1);
  }
  return { rows: afterRows.filter((row) => matches(row, filter)), skipped };
}

export function lastId(log: string): string | null { return read(log).rows.at(-1)?.id ?? null; }

export async function wait(log: string, filter: Filter = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Row | null> {
  const started = Date.now();
  mkdirSync(dirname(log), { recursive: true });
  let wake: (() => void) | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try { watcher = watch(dirname(log), () => wake?.()); watcher.on('error', () => { watcher?.close(); watcher = undefined; }); } catch { /* Polling still guarantees progress. */ }
  try {
    while (!options.signal?.aborted) {
      const found = read(log, filter).rows[0];
      if (found) return found;
      const elapsed = Date.now() - started;
      if (options.timeoutMs !== undefined && elapsed >= options.timeoutMs) return null;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, Math.min(500, Math.max(1, (options.timeoutMs ?? 500) - elapsed)));
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      wake = undefined;
    }
    return null;
  } finally { watcher?.close(); }
}

export function follow(log: string, filter: Filter, onRow: (row: Row) => void, options: { after?: string; onSkipped?: (count: number) => void } = {}): () => void {
  let cursor = options.after ?? '';
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    const result = read(log, { ...filter, after: cursor });
    if (result.skipped) options.onSkipped?.(result.skipped);
    for (const row of result.rows) { cursor = row.id; onRow(row); }
  };
  const timer = setInterval(poll, 500);
  let watcher: ReturnType<typeof watch> | undefined;
  const watchParent = () => {
    try {
      watcher = watch(dirname(log), (_event, filename) => { if (!filename || filename.toString() === log.split('/').at(-1)) poll(); });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch { /* Parent may not exist yet; polling remains active. */ }
  };
  if (!existsSync(dirname(log))) mkdirSync(dirname(log), { recursive: true });
  watchParent();
  poll();
  return () => { stopped = true; clearInterval(timer); watcher?.close(); };
}

export function hasFinished(log: string, agent: string, after: string | null): boolean {
  return read(log, { from: agent, kind: 'finish', ...(after ? { after } : {}) }).rows.length > 0;
}

export function hasStopped(log: string, agent: string, after: string | null): boolean {
  return read(log, { from: agent, kind: 'stopped', ...(after ? { after } : {}) }).rows.some((row) => row.fields.started_after === after);
}
