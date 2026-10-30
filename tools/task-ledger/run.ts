// One pass of the harness: notice runs that died without reporting, then start the next task that may start.
// herdr-run.sh reports its own start and end to the ledger (`task started` / `task ended`), so a pass only has
// to start work and to catch the runs that vanished in between. Design: handoff/task-ledger-design.md
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE, defaultPath, type Ledger, type Task, type Worker } from './ledger.ts';
import { sweepHerdrTabs } from './advance.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HERDR_RUN = process.env.TASK_HERDR_RUN ?? join(HERE, '../../skills/herdr/herdr-run.sh');
// Above this share of CPU or memory nothing new starts (the user's rule: use 6〜8 割 of the PC).
export const BUSY = Number(process.env.TASK_BUSY ?? 0.8);

// Settings that belong to one run of herdr-run.sh. A pass that runs inside a worker's run (its `task ended` starts the
// next task) must not hand them on: RESUME=newtab from a resend made a fresh task look for a copy it never had (10/28).
const RUN_ONLY = ['RESUME', 'SKIP_IMPL', 'BASE', 'COMMIT_DIRTY', 'HERDR_RUN_SELF', 'TASK_ID', 'TASK_ISSUE_ID', 'TASK_CHECK', 'SEND_BACK'];

/** The environment for herdr-run.sh; per-task settings override inherited settings while absent values keep today's defaults. */
export function workerEnv(extra: Record<string, string>, task?: Pick<Task, 'worker' | 'model' | 'effort'>): NodeJS.ProcessEnv {
  const worker: Worker = task?.worker ?? 'pi';
  // Inherited run settings are fallbacks only: a task's chosen worker must not be overwritten by
  // the parent process (which may itself be a Pi/Codex worker starting the next ledger task).
  const env: NodeJS.ProcessEnv = { ...process.env, PI_PROVIDER: process.env.PI_PROVIDER ?? 'openai', PI_MODEL: process.env.PI_MODEL ?? 'gpt-6-luna', PI_THINKING: process.env.PI_THINKING ?? 'high', AGENT_CHANNEL_SUPERVISOR: process.env.AGENT_CHANNEL_SUPERVISOR ?? 'task-ledger' };
  env.IMPL_AGENT = worker;
  if (task?.model) env[worker === 'pi' ? 'PI_MODEL' : worker === 'codex' ? 'CODEX_MODEL' : 'CLAUDE_MODEL'] = task.model;
  if (task?.effort) env[worker === 'pi' ? 'PI_THINKING' : worker === 'codex' ? 'CODEX_EFFORT' : 'CLAUDE_EFFORT'] = task.effort;
  for (const key of RUN_ONLY) delete env[key];
  return { ...env, HERDR_ENV: '1', ...extra };
}

export type RunDeps = {
  /** Starts herdr-run.sh for the task and returns the process id, or throws. */
  start: (task: Task, name: string, extraEnv?: Record<string, string>) => number;
  /** Starts `task advance <id>` (check, review, merge) in the background. */
  advance: (task: Task) => void;
  alive: (pid: number) => boolean;
  /** The busier of CPU and memory, 0〜1. */
  load: () => number;
  /** Sweeps finished herdr tabs at the start of every harness pass. */
  sweep?: (ledger: Ledger) => string[];
};

/** The herdr-run task name: the brief's file name without `.md`. */
export function runName(task: Task): string {
  return basename(task.brief ?? '', extname(task.brief ?? ''));
}

export function runOnce(ledger: Ledger, deps: RunDeps): string[] {
  const said: string[] = deps.sweep?.(ledger) ?? [];
  for (const task of ledger.list().filter((candidate) => ACTIVE.includes(candidate.status))) {
    if (task.runner === null || deps.alive(task.runner)) continue;
    ledger.setStatus(task.id, '判断待ち', `${task.status}の仕事を進めていたプロセス（PID ${task.runner}）が、終わりを書かずに消えた。ログ: ${logPath(task.id)}`);
    ledger.releaseRunner(task.id);
    said.push(`${task.id}: 進めていたプロセスが消えたので判断待ち`);
  }
  const load = deps.load();
  if (load > BUSY) {
    said.push(`PC が忙しい（${Math.round(load * 100)}%）ので、新しい仕事は出さない`);
    return said;
  }
  // Finished work goes on toward merging before anything new starts.
  for (const task of ledger.list().filter((candidate) => ['確かめ中', 'レビュー中', '取り込み中'].includes(candidate.status) && candidate.runner === null)) {
    deps.advance(task);
    said.push(`${task.id}: ${task.status}から先へ進める`);
  }
  // Look-and-feel work is Claude's own (10/26 「見た目が関わるやつはpiに任せたら良くないぞ」), so it stays 待ち.
  const task = ledger.claimNext((candidate) => candidate.kind === '見た目', 'ハーネスが出した');
  for (const waiting of ledger.ready().filter((candidate) => candidate.kind === '見た目')) said.push(`${waiting.id}: 見た目の仕事なので Claude の番`);
  if (!task) return said;
  try {
    const name = runName(task);
    const workRoot = process.env.HERDR_WORK ?? process.env.CODEX_WORK ?? join(homedir(), '.cache', `herdr-${basename(task.repo)}`);
    const copy = task.workdir ?? join(workRoot, 'wt', name);
    // claimNext increments attempts before start; 2 means there was an earlier attempt before this launch.
    const resume: Record<string, string> = task.attempts >= 2 && existsSync(copy) ? { RESUME: 'newtab' } : {};
    // A task returned to 待ち after an earlier run starts from a clean copy. Retries within
    // the same attempt still use RESUME=newtab and retain their existing worktree.
    if (task.attempts === 1 && (existsSync(copy) || existsSync(join(workRoot, `reviewed-${name}`)) || existsSync(join(workRoot, `patch-${name}.diff`)))) cleanupPreviousRun(task, name, copy, workRoot);
    const pid = deps.start(task, name, resume);
    ledger.setRunner(task.id, { runner: pid });
    said.push(`${task.id}: 出した（${runName(task)}、PID ${pid}）`);
  } catch (error) {
    ledger.setStatus(task.id, '判断待ち', `出せなかった: ${error instanceof Error ? error.message : String(error)}`);
    said.push(`${task.id}: 出せなかったので判断待ち`);
  }
  return said;
}

function cleanupPreviousRun(task: Task, name: string, copy: string, workRoot: string): void {
  if (existsSync(copy)) {
    // Include non-ignored untracked files in the diff before removing the worktree.
    const intent = spawnSync('git', ['-C', copy, 'add', '-A', '-N'], { encoding: 'utf8' });
    if (intent.error) throw intent.error;
    if (intent.status !== 0) throw new Error(`前回 worktree の未追跡ファイルを差分対象にできない: ${intent.stderr}`);
    const dirty = spawnSync('git', ['-C', copy, 'diff', '--binary', 'HEAD'], { encoding: 'buffer' });
    if (dirty.error) throw dirty.error;
    if (dirty.status !== 0 && dirty.status !== 1) throw new Error(`前回 worktree の diff を取得できない: ${dirty.stderr?.toString() ?? ''}`);
    if (dirty.stdout.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let patch = join(workRoot, `patch-${name}-prev-${stamp}.diff`);
      let suffix = 1;
      while (existsSync(patch)) patch = join(workRoot, `patch-${name}-prev-${stamp}-${suffix++}.diff`);
      writeFileSync(patch, dirty.stdout);
    }
    const removed = spawnSync('git', ['-C', task.repo, 'worktree', 'remove', '--force', copy], { encoding: 'utf8' });
    if (removed.status !== 0) throw new Error(`前回 worktree を片付けられない: ${removed.stderr}`);
  }
  const branch = spawnSync('git', ['-C', task.repo, 'branch', '-D', `herdr/${name}`], { encoding: 'utf8' });
  if (branch.status !== 0 && !branch.stderr.includes('not found')) throw new Error(`前回ブランチを片付けられない: ${branch.stderr}`);
  rmSync(join(workRoot, `reviewed-${name}`), { force: true });
  rmSync(join(workRoot, `patch-${name}.diff`), { force: true });
}

export function logPath(id: string): string {
  return join(dirname(defaultPath()), 'logs', `${id}.log`);
}

export const realDeps: RunDeps = {
  start(task, name, extraEnv = {}) {
    const workspace = process.env.HERDR_WORKSPACE_ID ?? process.env.TASK_HERDR_WORKSPACE;
    if (!workspace) throw new Error('herdr のワークスペースが分からない（HERDR_WORKSPACE_ID か TASK_HERDR_WORKSPACE）');
    mkdirSync(dirname(logPath(task.id)), { recursive: true });
    const out = openSync(logPath(task.id), 'a');
    try {
      const child = spawn('bash', [HERDR_RUN, name], {
        cwd: task.repo, detached: true, stdio: ['ignore', out, out],
        env: workerEnv({ HERDR_WORKSPACE_ID: workspace, REPO: task.repo, TASK_ID: task.id, ...(task.check ? { TASK_CHECK: task.check } : {}), ...(task.issue_id && task.brief === `handoff/${task.issue_id}.md` ? { TASK_ISSUE_ID: task.issue_id } : {}), ...extraEnv }, task),
      });
      if (!child.pid) throw new Error('herdr-run.sh を起動できなかった');
      child.unref();
      return child.pid;
    } finally { closeSync(out); }
  },
  advance(task) {
    mkdirSync(dirname(logPath(task.id)), { recursive: true });
    const out = openSync(logPath(task.id), 'a');
    try {
      spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, 'cli.ts'), 'advance', task.id], { detached: true, stdio: ['ignore', out, out] }).unref();
    } finally { closeSync(out); }
  },
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  sweep(ledger) { return sweepHerdrTabs(ledger); },
  load() {
    const cpu = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) / cpus().length;
    const mem = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((p) => p.length === 2).map(([k, v]) => [k, parseInt(v!, 10)]));
    return Math.max(cpu, 1 - (mem.MemAvailable ?? 0) / (mem.MemTotal || 1));
  },
};
