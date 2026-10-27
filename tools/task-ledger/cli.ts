// `task`: the command people and the commanding Claude use to put tasks into the ledger and read it.
// Moving a task through 走行中 → 済 is the harness's job, not this command's (except hold / drop / answer).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { KINDS, Ledger, STATUSES, type Kind, type Status, type Task } from './ledger.ts';
import { realDeps, runOnce, type RunDeps } from './run.ts';
import { advance, realAdvanceDeps, type AdvanceDeps } from './advance.ts';

const USAGE = `使い方:
  task add --title <題> --why <ユーザーの言葉と日付> [--brief <依頼文のパス>] [--check <確かめのコマンド>]
           [--after <id,...>] [--files <パス,...>] [--kind 処理|見た目|調べ] [--deploy] [--repo <パス>]
  task brief <id> <依頼文のパス> [--check <コマンド>]   依頼文を付ける（依頼文待ち → 待ち）
  task list [--all] [--repo <パス>] [--status <状態>]
  task show <id>
  task ready                                            いま出してよい仕事
  task hold <id> <理由といつ見直すか>
  task drop <id> <理由>
  task answer <id> <答え> [--to 待ち|やめ|保留]          判断待ちに答える（既定は 待ち に戻す）
  task export [--repo <パス>]                           ROADMAP 用の一覧（読む用の写し）
  task run                                              1 回まわす（消えたプロセスを見つけ、終わった仕事を先へ進め、次の仕事を 1 つ出す）
ハーネスの中で使うもの:
  task started <id> --agent <名> --runner <PID> [--workdir <パス>]   台本が動き始めた（herdr-run.sh が呼ぶ）
  task advance <id>                                     確かめ → レビュー → 取り込み（task run が裏で起こす）
  task ended <id> implemented|stopped|blocked|failed [--commit <sha>] [--log <パス>]`;

// What herdr-run.sh's end marker means for the ledger.
const ENDED: Record<string, { status: Status; note: string }> = {
  implemented: { status: '確かめ中', note: '作業役が終わった' },
  stopped: { status: '判断待ち', note: '作業役が設計の下見で STOP と書いた' },
  blocked: { status: '判断待ち', note: '作業役が確認の画面で止まった' },
  failed: { status: '判断待ち', note: '作業役を回す台本が失敗した' },
};

function repoRoot(path: string): string {
  try { return execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return resolve(path); }
}

function briefPath(repo: string, path: string): string {
  const full = isAbsolute(path) ? path : join(repo, path);
  if (!existsSync(full)) throw new Error(`依頼文がありません: ${full}`);
  return path;
}

function line(task: Task): string {
  const extra = [task.after.length ? `後: ${task.after.join(',')}` : '', task.note ?? ''].filter(Boolean).join(' / ');
  return `${task.id}\t${task.status}\t${task.title}${extra ? `\t(${extra})` : ''}`;
}

export function main(argv: string[], out: (text: string) => void = console.log, deps: RunDeps = realDeps, advanceDeps: AdvanceDeps = realAdvanceDeps): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    title: { type: 'string' }, why: { type: 'string' }, brief: { type: 'string' }, check: { type: 'string' },
    after: { type: 'string' }, files: { type: 'string' }, kind: { type: 'string' }, deploy: { type: 'boolean' },
    repo: { type: 'string' }, all: { type: 'boolean' }, status: { type: 'string' }, to: { type: 'string' },
    agent: { type: 'string' }, runner: { type: 'string' }, commit: { type: 'string' }, log: { type: 'string' }, workdir: { type: 'string' },
  } });
  const ledger = new Ledger();
  try {
    const repo = values.repo ? repoRoot(values.repo) : undefined;
    switch (command) {
      case 'add': {
        const root = repo ?? repoRoot(process.cwd());
        if (values.kind && !KINDS.includes(values.kind as Kind)) throw new Error(`--kind は ${KINDS.join('・')}`);
        const task = ledger.add({
          repo: root, title: values.title ?? '', why: values.why ?? '',
          brief: values.brief ? briefPath(root, values.brief) : null, check: values.check,
          after: values.after?.split(',').map((s) => s.trim()).filter(Boolean),
          files: values.files?.split(',').map((s) => s.trim()).filter(Boolean),
          kind: values.kind as Kind | undefined, deploy: values.deploy,
        });
        out(line(task));
        return 0;
      }
      case 'brief': {
        const [id, path] = positionals;
        const task = ledger.get(id ?? '');
        if (!task || !path) throw new Error('task brief <id> <依頼文のパス>');
        out(line(ledger.setBrief(task.id, briefPath(task.repo, path), values.check)));
        return 0;
      }
      case 'list': {
        if (values.status && !STATUSES.includes(values.status as Status)) throw new Error(`--status は ${STATUSES.join('・')}`);
        for (const task of ledger.list({ repo, all: values.all, status: values.status as Status | undefined })) out(line(task));
        return 0;
      }
      case 'show': {
        const task = ledger.get(positionals[0] ?? '');
        if (!task) throw new Error(`台帳にありません: ${positionals[0] ?? ''}`);
        out(JSON.stringify(task, null, 2));
        for (const event of ledger.events(task.id)) out(`${event.at}  ${event.from_status ?? '—'} → ${event.to_status}${event.note ? `  ${event.note}` : ''}`);
        return 0;
      }
      case 'ready':
        for (const task of ledger.ready()) out(line(task));
        return 0;
      case 'hold': case 'drop': {
        const [id, ...words] = positionals;
        if (!id || words.length === 0) throw new Error(`task ${command} <id> <理由>`);
        out(line(ledger.setStatus(id, command === 'hold' ? '保留' : 'やめ', words.join(' '))));
        return 0;
      }
      case 'answer': {
        const [id, ...words] = positionals;
        const task = ledger.get(id ?? '');
        if (!task || words.length === 0) throw new Error('task answer <id> <答え>');
        if (task.status !== '判断待ち' && task.status !== '保留') throw new Error(`判断待ち・保留ではありません（今は ${task.status}）`);
        const to = (values.to ?? '待ち') as Status;
        if (!['待ち', 'やめ', '保留'].includes(to)) throw new Error('--to は 待ち・やめ・保留');
        out(line(ledger.setStatus(task.id, to, `答え: ${words.join(' ')}`)));
        return 0;
      }
      case 'export': {
        const tasks = ledger.list({ repo });
        out('# ROADMAP（台帳の写し。手で書き換えない。`task export` で作り直す）\n');
        for (const status of STATUSES) {
          const group = tasks.filter((task) => task.status === status);
          if (group.length === 0) continue;
          out(`## ${status}`);
          for (const task of group) out(`- ${task.title}（${task.id}）${task.note ? ` — ${task.note}` : ''}`);
          out('');
        }
        return 0;
      }
      case 'run':
        for (const said of runOnce(ledger, deps)) out(said);
        return 0;
      case 'advance': {
        if (!ledger.get(positionals[0] ?? '')) throw new Error(`台帳にありません: ${positionals[0] ?? ''}`);
        for (const said of advance(ledger, positionals[0]!, advanceDeps)) out(said);
        // A merge or a send-back may let the next task start.
        for (const said of runOnce(ledger, deps)) out(said);
        return 0;
      }
      case 'started': {
        const task = ledger.get(positionals[0] ?? '');
        if (!task) throw new Error(`台帳にありません: ${positionals[0] ?? ''}`);
        const runner = values.runner ? Number(values.runner) : null;
        if (task.status === '待ち') ledger.setStatus(task.id, '走行中', '手で出した', { agent: values.agent ?? null, runner, attempts: task.attempts + 1 });
        if (task.status === '待ち' || task.status === '走行中') ledger.setRunner(task.id, { agent: values.agent ?? null, runner, workdir: values.workdir ?? null });
        else throw new Error(`${task.id} は ${task.status} なので出せません（待ち・走行中だけ）`);
        out(line(ledger.get(task.id)!));
        return 0;
      }
      case 'ended': {
        const [id, outcome] = positionals;
        const task = ledger.get(id ?? '');
        if (!task) throw new Error(`台帳にありません: ${id ?? ''}`);
        const end = ENDED[outcome ?? ''];
        if (!end) throw new Error(`終わり方は ${Object.keys(ENDED).join('・')}`);
        if (task.status !== '走行中') throw new Error(`${task.id} は ${task.status} です（走行中のはず）`);
        const note = values.log ? `${end.note}。ログ: ${values.log}` : end.note;
        out(line(ledger.setStatus(task.id, end.status, note, { commit: values.commit ?? null })));
        // The script is about to exit; whoever checks the work next takes the task over.
        ledger.releaseRunner(task.id);
        return 0;
      }
      default:
        out(USAGE);
        return command ? 2 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally { ledger.close(); }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
