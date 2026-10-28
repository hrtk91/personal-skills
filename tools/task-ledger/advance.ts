// After a worker finishes: run the task's check, have Opus review it, then merge, deploy and clean up.
// One `task advance <id>` process carries one task as far as it can and leaves it at 済, 判断待ち, or back
// with the worker (走行中) carrying the reason. Design: handoff/task-ledger-design.md (流れ 3〜5)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPath, type Ledger, type Status, type Task } from './ledger.ts';
import { HERDR_RUN, logPath, runName } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AFTER_WORK: readonly Status[] = ['確かめ中', 'レビュー中', '取り込み中'];
// Sending work back to the worker, by a failed check or a review, counts toward this many runs in all.
export const MAX_ATTEMPTS = Number(process.env.TASK_MAX_ATTEMPTS ?? 3);
const CHECK_TIMEOUT = Number(process.env.TASK_CHECK_TIMEOUT_MS ?? 45 * 60_000);
const REVIEW_TIMEOUT = Number(process.env.TASK_REVIEW_TIMEOUT_MS ?? 30 * 60_000);
const DEPLOY_TIMEOUT = Number(process.env.TASK_DEPLOY_TIMEOUT_MS ?? 60 * 60_000);

export type Verdict = { verdict: '通す' | '直す' | '判断'; reasons: string[]; fixes: string[] };
export type Shell = { code: number; output: string };
export type AdvanceDeps = {
  sh: (command: string, cwd: string, timeoutMs: number) => Shell;
  /** Asks the reviewer and returns its whole answer. */
  review: (prompt: string, cwd: string, readable: string[]) => string;
  /** Starts herdr-run.sh again on the task's existing worktree and returns its process id. */
  resend: (task: Task, name: string) => number;
  /** Waits a little before looking again (merges in one repository go one at a time). */
  pause: () => void;
};

function tail(text: string, lines = 80): string {
  return text.split('\n').slice(-lines).join('\n');
}
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The last JSON object in the answer that has a known verdict. */
export function parseVerdict(answer: string): Verdict | null {
  const starts = [...answer.matchAll(/\{/g)].map((match) => match.index!).reverse();
  for (const start of starts) {
    const end = answer.lastIndexOf('}');
    for (let stop = end; stop > start; stop = answer.lastIndexOf('}', stop - 1)) {
      try {
        const value = JSON.parse(answer.slice(start, stop + 1)) as Partial<Verdict>;
        if (value.verdict !== '通す' && value.verdict !== '直す' && value.verdict !== '判断') break;
        const list = (items: unknown) => (Array.isArray(items) ? items.map(String) : []);
        return { verdict: value.verdict, reasons: list(value.reasons), fixes: list(value.fixes) };
      } catch { /* try a shorter span */ }
    }
  }
  return null;
}

export function advance(ledger: Ledger, id: string, deps: AdvanceDeps, pid = process.pid): string[] {
  const said: string[] = [];
  if (!ledger.claimRunner(id, AFTER_WORK, pid)) return [`${id}: ほかが進めているか、進める段ではない`];
  const stop = (note: string) => { ledger.setStatus(id, '判断待ち', note); ledger.releaseRunner(id); said.push(`${id}: 判断待ち（${note}）`); return said; };
  for (;;) {
    const task = ledger.get(id)!;
    if (task.status === '確かめ中') {
      if (!task.workdir || !existsSync(task.workdir)) return stop(`作業用のコピーが見つからない（${task.workdir ?? '記録なし'}）`);
      const check = checkTwice(task, deps, said, () => deps.sh(task.check ?? 'true', task.workdir!, CHECK_TIMEOUT), `check-${task.attempts}`);
      const path = writeLog(id, `check-${task.attempts}`, check.output);
      if (check.code !== 0) { sendBack(ledger, task, deps, `確かめのコマンド \`${task.check}\` が落ちた（終了コード ${check.code}）。`, tail(check.output), said, stop); return said; }
      ledger.setStatus(id, 'レビュー中', `確かめが通った。出力: ${path}`);
      said.push(`${id}: 確かめが通った`);
    } else if (task.status === 'レビュー中') {
      const workdir = task.workdir!;
      const base = deps.sh(`git merge-base HEAD ${quote(gitHead(task.repo, deps))}`, workdir, 60_000).output.trim();
      const diffPath = writeLog(id, `diff-${task.attempts}`, deps.sh(`git diff ${quote(base)} HEAD`, workdir, 60_000).output);
      const checkPath = logPath(id).replace(/\.log$/, `-check-${task.attempts}.log`);
      const answer = deps.review(reviewPrompt(task, diffPath, checkPath), workdir, [dirname(diffPath)]);
      writeLog(id, `review-${task.attempts}`, answer);
      const verdict = parseVerdict(answer);
      if (!verdict) return stop('レビューの答えから決まった形の JSON を読めなかった');
      said.push(`${id}: レビュー ${verdict.verdict}`);
      if (verdict.verdict === '判断') return stop(`レビュー: ${verdict.reasons.join(' / ')}`);
      if (verdict.verdict === '直す') {
        sendBack(ledger, task, deps, `レビューで直すことになった。${verdict.reasons.join(' ')}`, verdict.fixes.map((fix) => `- ${fix}`).join('\n'), said, stop);
        return said;
      }
      ledger.setStatus(id, '取り込み中', `レビュー: ${verdict.reasons.join(' / ') || '通す'}`);
    } else if (task.status === '取り込み中') {
      const lock = join(dirname(defaultPath()), 'merge-locks', task.repo.replaceAll('/', '_'));
      mkdirSync(dirname(lock), { recursive: true });
      while (!tryLock(lock)) deps.pause();
      let again: 'again' | void;
      try { again = merge(ledger, task, deps, said, stop); } finally { rmdirSync(lock); }
      if (again !== 'again') return said;
    } else {
      ledger.releaseRunner(id);
      return said;
    }
  }
}

function tryLock(path: string): boolean {
  try { mkdirSync(path); return true; } catch { return false; }
}

function gitHead(repo: string, deps: AdvanceDeps): string {
  return deps.sh('git rev-parse HEAD', repo, 60_000).output.trim();
}

/** Merges the work. Returns 'again' when the worker's copy took in the repository's newer commits and must be checked again. */
function merge(ledger: Ledger, task: Task, deps: AdvanceDeps, said: string[], stop: (note: string) => unknown): 'again' | void {
  const repo = task.repo;
  const branch = deps.sh('git branch --show-current', task.workdir!, 60_000).output.trim();
  if (!branch) return stop('作業用のコピーのブランチが分からない');
  const before = gitHead(repo, deps);
  // The worker's branch carries its brief and reports under handoff/, which often sit uncommitted in the repository
  // too, and git will not overwrite them. Move those aside (kept with the task's logs) before merging.
  const added = deps.sh(`git diff --name-only --diff-filter=A HEAD...${quote(branch)}`, repo, 60_000).output.split('\n').filter(Boolean);
  const untracked = new Set(deps.sh('git ls-files --others --exclude-standard', repo, 60_000).output.split('\n').filter(Boolean));
  const aside = logPath(task.id).replace(/\.log$/, '-untracked');
  const moved = added.filter((path) => untracked.has(path));
  for (const path of moved) {
    mkdirSync(dirname(join(aside, path)), { recursive: true });
    renameSync(join(repo, path), join(aside, path));
  }
  if (moved.length) said.push(`${task.id}: 本体のコミットしていない ${moved.length} 個を ${aside} へ移した`);
  // The repository's own name for commits, or the harness's when it has none.
  const merged = deps.sh(`git -c user.name="$(git config user.name || echo task-ledger)" -c user.email="$(git config user.email || echo task-ledger@noreply.invalid)" merge --no-ff --no-edit -m ${quote(`${task.title}\n\nTask: ${task.id}`)} ${quote(branch)}`, repo, 120_000);
  if (merged.code !== 0) {
    const conflicted = deps.sh('git diff --name-only --diff-filter=U', repo, 60_000).output.trim();
    deps.sh('git merge --abort', repo, 60_000);
    if (!conflicted) return stop(`本体に入れられなかった: ${tail(merged.output, 5)}`);
    return catchUp(ledger, task, deps, before, said, stop);
  }
  if (task.check) {
    // In a throwaway copy of the merged commit, never in the repository itself: a repository may serve its build
    // output to production straight from its folder (random-image did; 10/28). The copy borrows the folders
    // .herdr.env lists in EXTRA_DIRS (node_modules and the like) by link.
    const check = checkTwice(task, deps, said, () => deps.sh(`T=$(mktemp -d) && rmdir "$T" && git worktree add -q --detach "$T" HEAD || exit 97
for d in $(. ./.herdr.env >/dev/null 2>&1; echo "\${EXTRA_DIRS:-}"); do [ -e "$d" ] && [ ! -e "$T/$d" ] && mkdir -p "$T/$(dirname "$d")" && ln -s "$PWD/$d" "$T/$d"; done
(cd "$T" && ${task.check}); rc=$?
git worktree remove --force "$T" >/dev/null 2>&1; rm -rf "$T"; exit $rc`, repo, CHECK_TIMEOUT), 'merged-check');
    if (check.code !== 0) {
      // --keep leaves whatever else is uncommitted in the repository as it was.
      deps.sh(`git reset --keep ${quote(before)}`, repo, 60_000);
      return stop(`本体に入れたあとの確かめが落ちたので戻した。出力: ${writeLog(task.id, 'merged-check', check.output)}`);
    }
  }
  const commit = gitHead(repo, deps);
  if (task.deploy) {
    const deployed = deps.sh(`. ./.herdr.env 2>/dev/null; [ -n "\${TASK_DEPLOY:-}" ] || { echo '.herdr.env に TASK_DEPLOY が無い'; exit 3; }; TASK_ID=${quote(task.id)} eval "$TASK_DEPLOY"`, repo, DEPLOY_TIMEOUT);
    if (deployed.code !== 0) {
      return stop(`取り込んだ（${commit.slice(0, 7)}）が、本番に出せなかった。出力: ${writeLog(task.id, 'deploy', deployed.output)}`);
    }
    said.push(`${task.id}: 本番に出した`);
  }
  const cleaned = deps.sh(`bash ${quote(HERDR_RUN)} --cleanup ${quote(runName(task))}`, repo, 120_000);
  ledger.setStatus(task.id, '済', cleaned.code === 0 ? '取り込んだ' : `取り込んだが片付けに失敗: ${tail(cleaned.output, 3)}`, { commit });
  ledger.releaseRunner(task.id);
  said.push(`${task.id}: 済（${commit.slice(0, 7)}）`);
}

// The repository moved on while the worker was busy, and the two collide. Take the repository's commits into the
// worker's copy: if that goes in cleanly, check again; if files collide, leave git's conflict marks in them and
// hand the work back to the worker to settle.
function catchUp(ledger: Ledger, task: Task, deps: AdvanceDeps, head: string, said: string[], stop: (note: string) => unknown): 'again' | void {
  const workdir = task.workdir!;
  const into = deps.sh(`git -c user.name="$(git config user.name || echo task-ledger)" -c user.email="$(git config user.email || echo task-ledger@noreply.invalid)" merge --no-edit -m ${quote(`本体の ${head.slice(0, 7)} を取り込む（${task.id}）`)} ${quote(head)}`, workdir, 120_000);
  if (into.code === 0) {
    ledger.setStatus(task.id, '確かめ中', `本体が先に進んでいたので、作業役のコピーに本体の ${head.slice(0, 7)} を取り込んだ。確かめ直す`);
    said.push(`${task.id}: 本体を取り込んで確かめ直す`);
    return 'again';
  }
  const files = deps.sh('git diff --name-only --diff-filter=U', workdir, 60_000).output.trim().split('\n').filter(Boolean);
  if (files.length === 0) {
    deps.sh('git merge --abort', workdir, 60_000);
    return stop(`作業役のコピーに本体を取り込めなかった: ${tail(into.output, 5)}`);
  }
  sendBack(ledger, task, deps, `作業のあいだに本体が先に進み、同じ所を変えていた。次のファイルに git の衝突の印（<<<<<<< ・ ======= ・ >>>>>>>）がある: ${files.join('、')}。`,
    '両方の変更を生かして解き、印を全部消す。git のコマンド（merge・commit・checkout など）は使わない（台本がこのまま取り込みを仕上げる）。', said, stop);
}

// A check that fails runs once more before anything is decided: on a busy PC an e2e that the task never touched can
// time out (10/28: three different specs did, one per run). The first output is kept and the event names it.
function checkTwice(task: Task, deps: AdvanceDeps, said: string[], run: () => { code: number; output: string }, label: string): { code: number; output: string } {
  const first = run();
  if (first.code === 0) return first;
  const firstLog = writeLog(task.id, `${label}-first-fail`, first.output);
  const second = run();
  if (second.code === 0) said.push(`${task.id}: 確かめは 1 回目に落ち、流し直して通った（1 回目: ${firstLog}）`);
  return second.code === 0 ? { code: 0, output: `${second.output}\n\n[1 回目は落ちた（終了コード ${first.code}）: ${firstLog}]` } : second;
}

function writeLog(id: string, name: string, text: string): string {
  const path = logPath(id).replace(/\.log$/, `-${name}.log`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Gives the work back to the worker with the reason written into its brief, or stops after too many tries. */
function sendBack(ledger: Ledger, task: Task, deps: AdvanceDeps, reason: string, detail: string, said: string[], stop: (note: string) => unknown): void {
  if (task.attempts >= MAX_ATTEMPTS) return stop(`${MAX_ATTEMPTS} 回やって通らなかった。最後: ${reason}`);
  const brief = join(task.workdir!, task.brief!);
  appendFileSync(brief, `\n\n## 差し戻し（${task.attempts} 回目のあと。ハーネスより）\n${reason}\n\n${detail ? `\`\`\`\n${detail}\n\`\`\`\n\n` : ''}上を直し、報告を書き直してください。直したあとも依頼の終わりの条件を全部満たすこと。\n`);
  ledger.setStatus(task.id, '走行中', `差し戻し: ${reason}`, { attempts: task.attempts + 1 });
  ledger.releaseRunner(task.id);
  try {
    ledger.setRunner(task.id, { runner: deps.resend(task, runName(task)) });
    said.push(`${task.id}: 作業役に差し戻した`);
  } catch (error) {
    stop(`差し戻せなかった: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function reviewPrompt(task: Task, diffPath: string, checkPath: string): string {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '（無い）');
  const report = task.brief!.replace(/\.md$/, '-report.md');
  return `${read(join(HERE, 'review-prompt.md'))}
## この仕事
- 題: ${task.title}
- なぜ: ${task.why}
- 確かめのコマンド: ${task.check ?? '（無い）'}
- 作業用のコピー（いまの作業場所）: ${task.workdir}
- 差分: ${diffPath}（読んでください）
- 作業役の報告: ${report}（作業場所の中）
- 確かめの出力（全部）: ${checkPath}

## 依頼文（${task.brief}）
${read(join(task.workdir!, task.brief!))}

## 確かめの出力の終わり
\`\`\`
${tail(read(checkPath), 60)}
\`\`\`
`;
}

export const realAdvanceDeps: AdvanceDeps = {
  sh(command, cwd, timeoutMs) {
    const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TMPDIR: '/tmp' } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
    return { code: result.status ?? 124, output };
  },
  review(prompt, cwd, readable) {
    // Opus reads and judges only (10/27 「Opus」). It may read the work and the logs, never write.
    // Without the user's hooks and MCP servers: a Stop hook that waits for an hour kept `claude -p` from exiting (10/28).
    const result = spawnSync('claude', ['-p', '--model', 'opus', '--output-format', 'text',
      '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...readable.flatMap((dir) => ['--add-dir', dir])],
    { cwd, input: prompt, encoding: 'utf8', timeout: REVIEW_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
    return `${result.stdout ?? ''}${result.status === 0 ? '' : `\n（レビュー役が終了コード ${result.status} で終わった）${result.stderr ?? ''}`}`;
  },
  resend(task, name) {
    const out = openSync(logPath(task.id), 'a');
    try {
      const child = spawn('bash', [HERDR_RUN, name], {
        cwd: task.repo, detached: true, stdio: ['ignore', out, out],
        env: {
          IMPL_AGENT: 'pi', PI_PROVIDER: 'openai', PI_MODEL: 'gpt-6-luna', PI_THINKING: 'high', AGENT_CHANNEL_SUPERVISOR: 'task-ledger',
          ...process.env, HERDR_ENV: '1', REPO: task.repo, TASK_ID: task.id, RESUME: 'newtab',
          HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? process.env.TASK_HERDR_WORKSPACE ?? '',
        },
      });
      if (!child.pid) throw new Error('herdr-run.sh を起動できなかった');
      child.unref();
      return child.pid;
    } finally { closeSync(out); }
  },
  pause() { spawnSync('sleep', ['20']); },
};
