// One pass of the harness: notice runs that died without reporting, then start the next task that may start.
// herdr-run.sh reports its own start and end to the ledger (`task started` / `task ended`), so a pass only has
// to start work and to catch the runs that vanished in between. Design: handoff/task-ledger-design.md
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPath, type Ledger, type Task } from './ledger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HERDR_RUN = process.env.TASK_HERDR_RUN ?? join(HERE, '../../skills/herdr/herdr-run.sh');
// Above this share of CPU or memory nothing new starts (the user's rule: use 6〜8 割 of the PC).
export const BUSY = Number(process.env.TASK_BUSY ?? 0.8);

export type RunDeps = {
  /** Starts herdr-run.sh for the task and returns the process id, or throws. */
  start: (task: Task, name: string) => number;
  alive: (pid: number) => boolean;
  /** The busier of CPU and memory, 0〜1. */
  load: () => number;
};

/** The herdr-run task name: the brief's file name without `.md`. */
export function runName(task: Task): string {
  return basename(task.brief ?? '', extname(task.brief ?? ''));
}

export function runOnce(ledger: Ledger, deps: RunDeps): string[] {
  const said: string[] = [];
  for (const task of ledger.list({ status: '走行中' })) {
    if (task.runner === null || deps.alive(task.runner)) continue;
    ledger.setStatus(task.id, '判断待ち', `作業役を回す台本（PID ${task.runner}）が、終わりを書かずに消えた。ログ: ${logPath(task.id)}`);
    said.push(`${task.id}: 台本が消えたので判断待ち`);
  }
  const load = deps.load();
  if (load > BUSY) {
    said.push(`PC が忙しい（${Math.round(load * 100)}%）ので、新しい仕事は出さない`);
    return said;
  }
  // Look-and-feel work is Claude's own (10/26 「見た目が関わるやつはpiに任せたら良くないぞ」), so it stays 待ち.
  const task = ledger.claimNext((candidate) => candidate.kind === '見た目', 'ハーネスが出した');
  for (const waiting of ledger.ready().filter((candidate) => candidate.kind === '見た目')) said.push(`${waiting.id}: 見た目の仕事なので Claude の番`);
  if (!task) return said;
  try {
    const pid = deps.start(task, runName(task));
    ledger.setRunner(task.id, { runner: pid });
    said.push(`${task.id}: 出した（${runName(task)}、PID ${pid}）`);
  } catch (error) {
    ledger.setStatus(task.id, '判断待ち', `出せなかった: ${error instanceof Error ? error.message : String(error)}`);
    said.push(`${task.id}: 出せなかったので判断待ち`);
  }
  return said;
}

export function logPath(id: string): string {
  return join(dirname(defaultPath()), 'logs', `${id}.log`);
}

export const realDeps: RunDeps = {
  start(task, name) {
    const workspace = process.env.HERDR_WORKSPACE_ID ?? process.env.TASK_HERDR_WORKSPACE;
    if (!workspace) throw new Error('herdr のワークスペースが分からない（HERDR_WORKSPACE_ID か TASK_HERDR_WORKSPACE）');
    mkdirSync(dirname(logPath(task.id)), { recursive: true });
    const out = openSync(logPath(task.id), 'a');
    try {
      const child = spawn('bash', [HERDR_RUN, name], {
        cwd: task.repo, detached: true, stdio: ['ignore', out, out],
        env: {
          // Pi with luna, thinking high, no fast tier (10/25・10/26). The caller's environment wins.
          IMPL_AGENT: 'pi', PI_PROVIDER: 'openai', PI_MODEL: 'gpt-6-luna', PI_THINKING: 'high',
          AGENT_CHANNEL_SUPERVISOR: 'task-ledger',
          ...process.env,
          HERDR_ENV: '1', HERDR_WORKSPACE_ID: workspace, REPO: task.repo, TASK_ID: task.id,
        },
      });
      if (!child.pid) throw new Error('herdr-run.sh を起動できなかった');
      child.unref();
      return child.pid;
    } finally { closeSync(out); }
  },
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  load() {
    const cpu = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) / cpus().length;
    const mem = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((p) => p.length === 2).map(([k, v]) => [k, parseInt(v!, 10)]));
    return Math.max(cpu, 1 - (mem.MemAvailable ?? 0) / (mem.MemTotal || 1));
  },
};
