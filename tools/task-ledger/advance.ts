// After a worker finishes: run the task's check, have Opus review it, then merge, deploy and clean up.
// One `task advance <id>` process carries one task as far as it can and leaves it at 済, 判断待ち, or back
// with the worker (走行中) carrying the reason. Design: handoff/task-ledger-design.md (流れ 3〜5)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPath, type Ledger, type SpanAttributes, type Status, type Task } from './ledger.ts';
import { assembleIssueBrief } from './issue-brief.ts';
import { HERDR_RUN, logPath, runName, workerEnv } from './run.ts';

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
  /** Asks the reviewer and returns its whole answer, with what the call cost when that is known (for the trace). */
  review: (prompt: string, cwd: string, readable: string[]) => string | { answer: string; attributes: SpanAttributes };
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
  if (!ledger.claimRunner(id, AFTER_WORK, pid)) return [...said, `${id}: ほかが進めているか、進める段ではない`];
  const stop = (note: string) => { ledger.setStatus(id, '判断待ち', note); ledger.releaseRunner(id); said.push(`${id}: 判断待ち（${note}）`); return said; };
  for (;;) {
    const task = ledger.get(id)!;
    if (task.status === '確かめ中') {
      if (!task.workdir || !existsSync(task.workdir)) return stop(`作業用のコピーが見つからない（${task.workdir ?? '記録なし'}）`);
      const check = checkTwice(ledger, task, said, () => deps.sh(task.check ?? 'true', task.workdir!, CHECK_TIMEOUT), `check-${task.attempts}`, '確かめ');
      const path = writeLog(id, `check-${task.attempts}`, check.output);
      if (check.code !== 0) { sendBack(ledger, task, deps, `確かめのコマンド \`${task.check}\` が落ちた（終了コード ${check.code}）。`, tail(check.output), said, stop); return said; }
      ledger.setStatus(id, 'レビュー中', `確かめが通った。出力: ${path}`);
      said.push(`${id}: 確かめが通った`);
      const reportPath = join(task.workdir!, task.brief!.replace(/\.md$/, '-report.md'));
      const reportCheck = timed(ledger, task, '報告を見る', () => {
        try { return readFileSync(reportPath, 'utf8'); } catch { return null; }
      }, (text) => ({ ok: text !== null, attributes: { 'report.status': text === null ? '読めない' : classifyCompletion(text).kind } }));
      if (reportCheck !== null) {
        const completion = classifyCompletion(reportCheck);
        if (completion.kind === '未完了' && completion.line) {
          const reason = `作業役の報告が、終わりの条件を満たしていないと書いている: ${completion.line}`;
          if (completion.undecidable !== null) return stop(`作業役が終わりの条件を満たせない理由を決められない: ${completion.undecidable}`);
          sendBack(ledger, task, deps, reason,
            `依頼文の「やってよいこと」に入っている手でそれを満たしてから、報告を書き直す。満たせない理由が作業役では決められないことなら、その理由を報告に書いて「終わりの条件: 満たしていない — 決められない: <理由>」と書く。`, said, stop);
          return said;
        }
      }
    } else if (task.status === 'レビュー中') {
      const workdir = task.workdir!;
      const base = deps.sh(`git merge-base HEAD ${quote(gitHead(task.repo, deps))}`, workdir, 60_000).output.trim();
      const diffPath = writeLog(id, `diff-${task.attempts}`, deps.sh(`git diff ${quote(base)} HEAD`, workdir, 60_000).output);
      const checkPath = logPath(id).replace(/\.log$/, `-check-${task.attempts}.log`);
      const reply = timed(ledger, task, 'レビュー', () => deps.review(reviewPrompt(task, diffPath, checkPath), workdir, [dirname(diffPath)]), (got) => {
        const found = parseVerdict(typeof got === 'string' ? got : got.answer);
        return { ok: found !== null, attributes: { ...(typeof got === 'string' ? {} : got.attributes), 'review.verdict': found?.verdict ?? '読めない' } };
      });
      const answer = typeof reply === 'string' ? reply : reply.answer;
      const reviewSession = typeof reply === 'string' ? undefined : reply.attributes?.['review.session_id'];
      if (typeof reviewSession === 'string') ledger.setSessionId(id, 'review', reviewSession);
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

export type SweepCandidate = { tabId: string; name: string; reason: string; task: Task | null };
type HerdrTab = { tab_id: string; label?: string };
type HerdrPane = { tab_id: string; cwd?: string };
type SweepOptions = {
  now?: number;
  roots?: string[];
  tabs?: HerdrTab[];
  panes?: HerdrPane[];
  running?: (name: string) => boolean;
  close?: (tabId: string) => void;
  dryRun?: boolean;
};

/** Finds only tabs whose IDs are explicitly present in a herdr-run log. */
export function herdrTabSweepCandidates(ledger: Ledger, options: SweepOptions = {}): SweepCandidate[] {
  const now = options.now ?? Date.now();
  const roots = options.roots ?? defaultHerdrRoots();
  const tabs = options.tabs ?? herdrJson('tab', 'list').tabs;
  const panes = options.panes ?? herdrJson('pane', 'list').panes;
  const paneRoots = panes.map((pane) => pane.cwd).filter((cwd): cwd is string => !!cwd).map((cwd) => dirname(dirname(cwd)));
  const eligibleTabs = new Set(tabs.filter((tab) => typeof tab.label === 'string').map((tab) => `${tab.tab_id}\0${tab.label}`));
  const tasks = ledger.list({ all: true });
  const byName = new Map<string, Task[]>();
  for (const task of tasks.filter((item) => item.brief)) {
    const name = basename(task.brief!, '.md');
    byName.set(name, [...(byName.get(name) ?? []), task]);
  }
  const candidates: SweepCandidate[] = [];
  for (const root of new Set([...roots, ...paneRoots])) {
    let logs: string[];
    try { logs = readdirSync(root).filter((file) => /^herdr-[A-Za-z0-9][A-Za-z0-9_-]*\.log$/.test(file)); } catch { continue; }
    for (const file of logs) {
      const name = file.slice('herdr-'.length, -'.log'.length);
      let text = ''; let mtime = 0;
      try { text = readFileSync(join(root, file), 'utf8'); mtime = statSync(join(root, file)).mtimeMs; } catch { continue; }
      const tabId = [...text.matchAll(/タブ: ([^（\s]+)（/g)].at(-1)?.[1];
      if (!tabId || !eligibleTabs.has(`${tabId}\0${name}`)) continue;
      const matches = byName.get(name) ?? [];
      if (matches.length > 1) continue; // Identical run names across repositories are ambiguous; fail closed.
      const task = matches[0] ?? null;
      if (task && ['判断待ち', '保留', '走行中', '確かめ中', 'レビュー中', '取り込み中'].includes(task.status)) continue;
      if (options.running?.(name) ?? isRunActive(name)) continue;
      const cwd = panes.filter((pane) => pane.tab_id === tabId).map((pane) => pane.cwd).filter((value): value is string => !!value);
      let reason: string | null = null;
      if (cwd.length > 0 && cwd.every((path) => !existsSync(path))) reason = `作業用フォルダが無い（${cwd.join('、')}）`;
      if (!reason && task && ['済', 'やめ'].includes(task.status)) {
        const finished = Date.parse(ledger.events(task.id).at(-1)?.at ?? task.updated_at);
        if (now - finished >= 10 * 60_000) reason = `${task.status}から10分経過`;
      }
      if (!reason && !task && now - mtime >= 6 * 60 * 60_000) reason = '台帳外・ログ最終更新から6時間経過';
      if (reason) candidates.push({ tabId, name, reason, task });
    }
  }
  return candidates;
}

/** One harness pass: close eligible tabs, or only list them when dryRun is requested. */
export function sweepHerdrTabs(ledger: Ledger, options: SweepOptions = {}): string[] {
  let candidates: SweepCandidate[];
  try { candidates = herdrTabSweepCandidates(ledger, options); } catch (error) {
    return [`herdr タブ掃除を見送った（一覧を読めない: ${error instanceof Error ? error.message : String(error)}）`];
  }
  const said: string[] = [];
  if (candidates.length === 0) return ['掃除候補なし'];
  for (const candidate of candidates) {
    if (options.dryRun ?? process.env.TASK_HERDR_SWEEP_DRY_RUN === '1') {
      said.push(`掃除候補: ${candidate.tabId}（${candidate.name}）— ${candidate.reason}`);
      continue;
    }
    try {
      (options.close ?? ((tabId) => herdrCommand('tab', 'close', tabId)))(candidate.tabId);
      if (candidate.task) {
        const at = new Date().toISOString();
        ledger.recordSpan({ task_id: candidate.task.id, attempt: candidate.task.attempts, name: '片付け', start: at, end: at, ok: true,
          attributes: { 'cleanup.tab_id': candidate.tabId, 'cleanup.reason': candidate.reason } });
      }
      said.push(`タブを片付けた: ${candidate.tabId}（${candidate.name}）— ${candidate.reason}`);
    } catch (error) { said.push(`タブを閉じられなかった: ${candidate.tabId}（${String(error)}）`); }
  }
  return said;
}

function defaultHerdrRoots(): string[] {
  const cache = join(process.env.HOME ?? '', '.cache');
  const configured = process.env.HERDR_WORK;
  let roots: string[] = [];
  try { roots = readdirSync(cache).filter((entry) => entry.startsWith('herdr-')).map((entry) => join(cache, entry)); } catch { /* no cache */ }
  return [...new Set([...(configured ? [configured] : []), ...roots])];
}

function herdrJson(group: string, action: string): { tabs: HerdrTab[]; panes: HerdrPane[] } {
  const result = JSON.parse(herdrCommand(group, action)) as { result?: { tabs?: HerdrTab[]; panes?: HerdrPane[] } };
  return { tabs: result.result?.tabs ?? [], panes: result.result?.panes ?? [] };
}
function herdrCommand(...args: string[]): string {
  const result = spawnSync(process.env.HERDR_BIN ?? 'herdr', args, { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr || `herdr ${args.join(' ')} failed`);
  return result.stdout;
}
function isRunActive(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`herdr-run\\.sh\\s+${escaped}(?:\\s|$)`);
  try {
    return readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return false;
      try { return pattern.test(readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ')); } catch { return false; }
    });
  } catch { return false; }
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
  const merged = timed(ledger, task, '本体に入れる', () => deps.sh(`git -c user.name="$(git config user.name || echo task-ledger)" -c user.email="$(git config user.email || echo task-ledger@noreply.invalid)" merge --no-ff --no-edit -m ${quote(`${task.title}\n\nTask: ${task.id}`)} ${quote(branch)}`, repo, 120_000), exitCode);
  if (merged.code !== 0) {
    const conflicted = deps.sh('git diff --name-only --diff-filter=U', repo, 60_000).output.trim();
    deps.sh('git merge --abort', repo, 60_000);
    if (!conflicted) return stop(`本体に入れられなかった: ${tail(merged.output, 5)}`);
    return catchUp(ledger, task, deps, before, said, stop);
  }
  const mergeCommit = gitHead(repo, deps);
  if (task.check) {
    // In a throwaway copy of the merged commit, never in the repository itself: a repository may serve its build
    // output to production straight from its folder (random-image did; 10/28). The copy borrows the folders
    // .herdr.env lists in EXTRA_DIRS (node_modules and the like) by link.
    const check = checkTwice(ledger, task, said, () => deps.sh(`T=$(mktemp -d) && rmdir "$T" && git worktree add -q --detach "$T" HEAD || exit 97
for d in $(. ./.herdr.env >/dev/null 2>&1; echo "\${EXTRA_DIRS:-}"); do [ -e "$d" ] && [ ! -e "$T/$d" ] && mkdir -p "$T/$(dirname "$d")" && ln -s "$PWD/$d" "$T/$d"; done
(cd "$T" && ${task.check}); rc=$?
git worktree remove --force "$T" >/dev/null 2>&1; rm -rf "$T"; exit $rc`, repo, CHECK_TIMEOUT), 'merged-check', '取り込み後の確かめ');
    if (check.code !== 0) {
      // --keep leaves whatever else is uncommitted in the repository as it was. When someone committed on top while the
      // check ran (Claude's brief did, 10/28, and the reset took it away), undo the merge with a revert instead.
      deps.sh(`if [ "$(git rev-parse HEAD)" = ${quote(mergeCommit)} ]; then git reset --keep ${quote(before)}; else git -c user.name="$(git config user.name || echo task-ledger)" -c user.email="$(git config user.email || echo task-ledger@noreply.invalid)" revert --no-edit -m 1 ${quote(mergeCommit)}; fi`, repo, 60_000);
      return stop(`本体に入れたあとの確かめが落ちたので戻した。出力: ${writeLog(task.id, 'merged-check', check.output)}`);
    }
  }
  const commit = gitHead(repo, deps);
  if (task.deploy) {
    const deployed = timed(ledger, task, '本番に出す', () => deps.sh(`. ./.herdr.env 2>/dev/null; [ -n "\${TASK_DEPLOY:-}" ] || { echo '.herdr.env に TASK_DEPLOY が無い'; exit 3; }; TASK_ID=${quote(task.id)} eval "$TASK_DEPLOY"`, repo, DEPLOY_TIMEOUT), exitCode);
    if (deployed.code !== 0) {
      return stop(`取り込んだ（${commit.slice(0, 7)}）が、本番に出せなかった。出力: ${writeLog(task.id, 'deploy', deployed.output)}`);
    }
    said.push(`${task.id}: 本番に出した`);
  }
  const cleaned = timed(ledger, task, '片付け', () => deps.sh(`bash ${quote(HERDR_RUN)} --cleanup ${quote(runName(task))}`, repo, 120_000), exitCode);
  ledger.setStatus(task.id, '済', cleaned.code === 0 ? '取り込んだ' : `取り込んだが片付けに失敗: ${tail(cleaned.output, 3)}`, { commit });
  ledger.releaseRunner(task.id);
  said.push(`${task.id}: 済（${commit.slice(0, 7)}）`);
}

// The repository moved on while the worker was busy, and the two collide. Take the repository's commits into the
// worker's copy: if that goes in cleanly, check again; if files collide, leave git's conflict marks in them and
// hand the work back to the worker to settle.
function catchUp(ledger: Ledger, task: Task, deps: AdvanceDeps, head: string, said: string[], stop: (note: string) => unknown): 'again' | void {
  const workdir = task.workdir!;
  const into = timed(ledger, task, '本体を作業役のコピーへ', () => deps.sh(`git -c user.name="$(git config user.name || echo task-ledger)" -c user.email="$(git config user.email || echo task-ledger@noreply.invalid)" merge --no-edit -m ${quote(`本体の ${head.slice(0, 7)} を取り込む（${task.id}）`)} ${quote(head)}`, workdir, 120_000), exitCode);
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
function checkTwice(ledger: Ledger, task: Task, said: string[], command: () => Shell, label: string, name: string): Shell {
  const run = (count: number) => timed(ledger, task, name, command, (result) => ({ ok: result.code === 0, attributes: { 'step.exit_code': result.code, 'step.run': count } }));
  const first = run(1);
  if (first.code === 0) return first;
  const firstLog = writeLog(task.id, `${label}-first-fail`, first.output);
  const second = run(2);
  if (second.code === 0) said.push(`${task.id}: 確かめは 1 回目に落ち、流し直して通った（1 回目: ${firstLog}）`);
  return second.code === 0 ? { code: 0, output: `${second.output}\n\n[1 回目は落ちた（終了コード ${first.code}）: ${firstLog}]` } : second;
}

function classifyCompletion(text: string): { kind: '満たした' | '未完了' | '行なし'; line: string | null; undecidable: string | null } {
  const line = text.split(/\r?\n/).find((item) => /^終わりの条件:/.test(item)) ?? null;
  if (!line) return { kind: '行なし', line: null, undecidable: null };
  if (!/^終わりの条件: *満たしていない/.test(line)) return { kind: '満たした', line, undecidable: null };
  const undecidable = line.match(/決められない:\s*(.*)$/)?.[1]?.trim() ?? null;
  return { kind: '未完了', line, undecidable };
}

/** Runs one harness step and records it in the task's trace (handoff/task-ledger-trace-design.md). */
function timed<T>(ledger: Ledger, task: Task, name: string, run: () => T, describe: (result: T) => { ok: boolean; attributes?: SpanAttributes }): T {
  const start = new Date().toISOString();
  const result = run();
  try {
    const { ok, attributes = {} } = describe(result);
    ledger.recordSpan({ task_id: task.id, attempt: task.attempts, name, start, end: new Date().toISOString(), ok, attributes });
  } catch { /* a trace that cannot be written never stops the work */ }
  return result;
}

function exitCode(result: Shell): { ok: boolean; attributes: SpanAttributes } {
  return { ok: result.code === 0, attributes: { 'step.exit_code': result.code } };
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
  const correction = `## 差し戻し（${task.attempts} 回目のあと。ハーネスより）\n${reason}\n\n${detail ? `\`\`\`\n${detail}\n\`\`\`\n\n` : ''}上を直し、報告を書き直してください。直したあとも依頼の終わりの条件を全部満たすこと。`;
  if (task.issue_id && task.brief === `handoff/${task.issue_id}.md`) {
    ledger.addIssueHistory(task.issue_id, correction);
    const issue = ledger.getIssue(task.issue_id)!;
    writeFileSync(brief, assembleIssueBrief(ledger, issue, task));
  } else appendFileSync(brief, `\n\n${correction}\n`);
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
    // The worker's settings must not reach the checks: herdr's own tests fail when they find a supervisor already set (10/28).
    const { AGENT_CHANNEL_SUPERVISOR: _supervisor, HERDR_RUN_SELF: _self, ...env } = process.env;
    const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...env, TMPDIR: '/tmp' } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
    return { code: result.status ?? 124, output };
  },
  review(prompt, cwd, readable) {
    // Opus reads and judges only (10/27 「Opus」). It may read the work and the logs, never write.
    // Without the user's hooks and MCP servers: a Stop hook that waits for an hour kept `claude -p` from exiting (10/28).
    const result = spawnSync('claude', ['-p', '--model', 'opus', '--output-format', 'json',
      '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...readable.flatMap((dir) => ['--add-dir', dir])],
    { cwd, input: prompt, encoding: 'utf8', timeout: REVIEW_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
    const failed = result.status === 0 ? '' : `\n（レビュー役が終了コード ${result.status} で終わった）${result.stderr ?? ''}`;
    // The JSON result carries the answer and what the call cost; anything else is passed on as it came.
    try {
      const json = JSON.parse(result.stdout ?? '') as { result?: string; session_id?: string; total_cost_usd?: number; duration_ms?: number; num_turns?: number; usage?: Record<string, number> };
      const usage = json.usage ?? {};
      const attributes: SpanAttributes = {};
      if (typeof json.session_id === 'string' && json.session_id) attributes['review.session_id'] = json.session_id;
      for (const [key, value] of Object.entries({
        'review.cost_usd': json.total_cost_usd, 'review.turns': json.num_turns, 'review.input_tokens': usage.input_tokens,
        'review.output_tokens': usage.output_tokens, 'review.cache_read_tokens': usage.cache_read_input_tokens, 'review.cache_write_tokens': usage.cache_creation_input_tokens,
      })) if (typeof value === 'number') attributes[key] = value;
      return { answer: `${json.result ?? ''}${failed}`, attributes };
    } catch {
      return `${result.stdout ?? ''}${failed}`;
    }
  },
  resend(task, name) {
    const out = openSync(logPath(task.id), 'a');
    try {
      const child = spawn('bash', [HERDR_RUN, name], {
        cwd: task.repo, detached: true, stdio: ['ignore', out, out],
        env: workerEnv({ REPO: task.repo, TASK_ID: task.id, RESUME: 'newtab',
          HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? process.env.TASK_HERDR_WORKSPACE ?? '' }),
      });
      if (!child.pid) throw new Error('herdr-run.sh を起動できなかった');
      child.unref();
      return child.pid;
    } finally { closeSync(out); }
  },
  pause() { spawnSync('sleep', ['20']); },
};
