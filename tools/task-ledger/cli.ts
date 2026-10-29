// `task`: the command people and the commanding Claude use to put tasks into the ledger and read it.
// Moving a task through 走行中 → 済 is the harness's job, not this command's (except hold / drop / answer).
import { answerTask } from './answer.ts';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTrace, renderTrace, report, toOtlp, tracesSince } from './trace.ts';
import { defaultPath, ISSUE_FIELDS, KINDS, WORKERS, Ledger, STATUSES, type Kind, type Status, type Task, type IssueField, type IssueFields, type Worker } from './ledger.ts';
import { assembleIssueBrief, issueTemplate, meaningful, parseIssueMarkdown } from './issue-brief.ts';
import { realDeps, runOnce, type RunDeps } from './run.ts';
import { taskContext } from './context.ts';
import { advance, realAdvanceDeps, sweepHerdrTabs, type AdvanceDeps } from './advance.ts';
import { refreshDecisionCards } from './decision/index.ts';

const USAGE = `使い方:
  task add --title <題> --why <ユーザーの言葉と日付> [--brief <依頼文のパス>] [--check <確かめのコマンド>] [--worker pi|codex|claude] [--model <モデル>] [--effort <強さ>]
           [--after <id,...>] [--files <パス,...>] [--kind 処理|見た目|調べ] [--deploy] [--repo <パス>]
  task brief <id> <依頼文のパス> [--check <コマンド>]   依頼文を付ける（依頼文待ち → 待ち）
  task list [--all] [--repo <パス>] [--status <状態>]
  task goal add --title <題> [--why <きっかけ>] [--stages a,b,c] | goal list | goal move <id> up|down|first
  task issue add (--title <題> [欄オプション...] | --from <md>) [--by あなた|Claude|作業役|レビュー] [--goal <id>] [--stage <工程>]
  task sweep --dry-run                                  herdr タブの片付け候補だけ表示
  task issue template | show <id> | brief <id>
  task issue list [--goal <id>|--loose] [--by <作成者>] [--open]
  task doc add --kind 仕様|設計|モック|決まり|説明|報告 --title <題> (--path <パス>|--body <中身>) [--goal <id>] | doc list [--goal <id>]
  task priority <task id> first|up|down
  task context <task id>
  task show <id>
  task ready                                            いま出してよい仕事
  task hold <id> <理由といつ見直すか>
  task drop <id> <理由>
  task decision refresh [<id>]                         判断待ちカードを作り直す
  task answer <id> <答え> [--to 待ち|やめ|保留|確かめ中|取り込み中]  判断待ちに答える（既定は 待ち に戻す。確かめ中 は Claude が作業役のコピーで直したとき、
                                                        取り込み中 は Claude がレビューの「直す」を越えて取り込むと決めたとき。答えに理由を書く）
  task export [--repo <パス>]                           ROADMAP 用の一覧（読む用の写し）
  task run                                              1 回まわす（消えたプロセスを見つけ、終わった仕事を先へ進め、次の仕事を 1 つ出す）
  task trace <id>                                       1 件の時間の流れ（状態ごと・ハーネスの段ごと）
  task report [--since <日時>] [--repo <パス>] [--json]  段ごとのかかった時間・戻った理由・レビューの費用
  task otel [--since <日時>] [--repo <パス>] [--out <パス>]  OTLP の JSON に書き出す（既定 ~/.local/share/task-ledger/traces/）
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

const KNOWN_COMMANDS = new Set(['cd', 'npm', 'node', 'python3', 'bash', 'npx']);

function shellCommandLooksRunnable(check: string): boolean {
  const first = check.trim().match(/^(?:'([^']+)'|"([^"]+)"|([^\s;&|<>()[\]]+))/);
  const command = first?.[1] ?? first?.[2] ?? first?.[3];
  if (!command || /[\u3000-\u9fff]/.test(command)) return false;
  if (KNOWN_COMMANDS.has(command)) return true;
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    const candidate = join(dir || '.', command);
    try { return existsSync(candidate) && (process.platform === 'win32' || (statSync(candidate).mode & 0o111) !== 0); }
    catch { return false; }
  });
}

function issueFiles(value: string): string[] {
  return value.split(/[，、,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Import paths are commonly repository-relative even when `task` is run from tools/task-ledger. */
function issueMarkdownPath(path: string): string {
  if (isAbsolute(path) || existsSync(path)) return path;
  const fromRoot = join(repoRoot(process.cwd()), path);
  if (existsSync(fromRoot)) return fromRoot;
  throw new Error(`Issue Markdown がありません: ${path}（確認先: ${resolve(path)}、${fromRoot}）`);
}

function line(task: Task): string {
  const extra = [task.after.length ? `後: ${task.after.join(',')}` : '', task.note ?? ''].filter(Boolean).join(' / ');
  const worker = [task.worker, task.model, task.effort].filter(Boolean).join('/');
  return `${task.id}\t${task.status}\t${task.title}${worker ? `\t[${worker}]` : ''}${extra ? `\t(${extra})` : ''}`;
}

export function main(argv: string[], out: (text: string) => void = console.log, deps: RunDeps = realDeps, advanceDeps: AdvanceDeps = realAdvanceDeps): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    title: { type: 'string' }, why: { type: 'string' }, brief: { type: 'string' }, check: { type: 'string' },
    after: { type: 'string' }, files: { type: 'string' }, kind: { type: 'string' }, deploy: { type: 'boolean' },
    worker: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    repo: { type: 'string' }, all: { type: 'boolean' }, status: { type: 'string' }, to: { type: 'string' },
    agent: { type: 'string' }, runner: { type: 'string' }, commit: { type: 'string' }, log: { type: 'string' }, workdir: { type: 'string' },
    since: { type: 'string' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, out: { type: 'string' }, issue: { type: 'string' }, body: { type: 'string' }, by: { type: 'string' }, from: { type: 'string' }, goal: { type: 'string' }, stage: { type: 'string' }, stages: { type: 'string' }, loose: { type: 'boolean' }, open: { type: 'boolean' }, docKind: { type: 'string' }, path: { type: 'string' },
    'なぜ': { type: 'string' }, '今の状態': { type: 'string' }, '関係する所': { type: 'string' }, 'やること': { type: 'string' }, 'やってよいこと': { type: 'string' }, 'やらないこと': { type: 'string' }, '終わりの条件': { type: 'string' }, '確かめのコマンド': { type: 'string' }, '触るファイル': { type: 'string' }, '種類': { type: 'string' }, '本番に出すか': { type: 'string' },
  } });
  const ledger = new Ledger();
  try {
    const repo = values.repo ? repoRoot(values.repo) : undefined;
    switch (command) {
      case 'add': {
        const root = repo ?? repoRoot(process.cwd());
        if (values.kind && !KINDS.includes(values.kind as Kind)) throw new Error(`--kind は ${KINDS.join('・')}`);
        if (values.worker && !WORKERS.includes(values.worker as Worker)) throw new Error(`--worker は ${WORKERS.join('・')}`);
        const issue = values.issue ? ledger.getIssue(values.issue) : null;
        if (values.issue && !issue) throw new Error(`Issue が台帳にありません: ${values.issue}`);
        let title = values.title ?? '', why = values.why ?? '', brief = values.brief ? briefPath(root, values.brief) : null;
        let check = values.check, files = values.files?.split(/[，、,\n]/).map((s) => s.trim()).filter(Boolean), kind = values.kind as Kind | undefined, deploy = values.deploy;
        let generatedIssueBrief = false;
        if (issue) {
          const missing = (['今の状態','関係する所'] as const).filter((field) => !meaningful(issue.fields[field], field));
          if (missing.length) throw new Error(`Issue の文脈が不足: ${missing.join('、')}`);
          title ||= issue.title; why ||= issue.fields['なぜ'] ?? '';
          if (!brief) { brief = `handoff/${issue.id}.md`; generatedIssueBrief = true; }
          check ??= issue.fields['確かめのコマンド'];
          files ??= issueFiles(issue.fields['触るファイル'] ?? '');
          if (check && !values.check && !shellCommandLooksRunnable(check)) {
            throw new Error(`Issue の「確かめのコマンド」はシェルで実行できるコマンドに見えません: ${check}（--check で上書きできます）`);
          }
          const invalidFiles = files.filter((path) => {
            const full = resolve(root, path);
            if (isAbsolute(path) || (full !== root && !full.startsWith(`${root}/`))) return true;
            if (existsSync(full)) return false;
            // A missing path with prose-like whitespace or Japanese text is not a concrete file target,
            // even when its parent directory exists (for example: "tools/ の差し戻しの記録まわり").
            if (/[\s\u3000-\u9fff]/u.test(path)) return true;
            // A not-yet-created file is a valid target when its directory prefix already exists in the repo.
            let parent = dirname(full);
            while (parent !== root && parent.startsWith(`${root}/`)) {
              if (existsSync(parent) && statSync(parent).isDirectory()) return false;
              parent = dirname(parent);
            }
            return true;
          });
          if (invalidFiles.length) throw new Error(`Issue の「触るファイル」にリポジトリにないパスがあります: ${invalidFiles.join('、')}（--files で上書きできます）`);
          kind ??= issue.fields['種類'] && KINDS.includes(issue.fields['種類'] as Kind) ? issue.fields['種類'] as Kind : undefined;
          deploy ??= /^(?:はい|する|true|yes)$/i.test(issue.fields['本番に出すか'] ?? '');
          if (generatedIssueBrief && !existsSync(join(root, brief))) {
            mkdirSync(dirname(join(root, brief)), { recursive: true });
            writeFileSync(join(root, brief), assembleIssueBrief(ledger, issue));
          }
        }
        const task = ledger.add({
          repo: root, title, why,
          brief, check,
          after: values.after?.split(',').map((s) => s.trim()).filter(Boolean),
          files,
          kind, deploy, issue_id: values.issue, worker: values.worker as Worker | undefined, model: values.model, effort: values.effort,
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
      case 'goal': {
        const [sub,...args]=positionals;
        if(sub==='add'){const g=ledger.addGoal({repo:repo??repoRoot(process.cwd()),title:values.title??'',why:values.why,stages:values.stages?.split(',').map(x=>x.trim()).filter(Boolean)});out(`${g.id}\t${g.status}\t${g.title}`);return 0;}
        if(sub==='list'){for(const g of ledger.listGoals(repo))out(`${g.id}\t${g.status}\t${g.title}\t${g.stages.join(',')}`);return 0;}
        if(sub==='move'){const d=args[1];if(!['up','down','first'].includes(d??''))throw new Error('task goal move <id> up|down|first');ledger.moveGoal(args[0]!,d as 'up'|'down'|'first');return 0;}
        throw new Error('task goal add|list|move');
      }
      case 'issue': {
        const [sub,...args]=positionals;
        if(sub==='template'){out(issueTemplate().trimEnd());return 0;}
        if(sub==='add'){
          const by=(values.by??'あなた') as 'あなた'|'Claude'|'作業役'|'レビュー'|'見張り役';if(!['あなた','Claude','作業役','レビュー','見張り役'].includes(by))throw new Error('--by は あなた・Claude・作業役・レビュー・見張り役');
          let title=values.title??'', fields:IssueFields={}, body=values.body;
          // Sections that are not template fields (設計, 報告 ...) stay with the Issue as its body and go into the brief.
          if(values.from){const source=issueMarkdownPath(values.from);const parsed=parseIssueMarkdown(readFileSync(source,'utf8'));title ||= parsed.title;fields=parsed.fields;body=[body,parsed.extra].filter(Boolean).join('\n\n');}
          else for(const field of ISSUE_FIELDS){const v=values[field];if(typeof v==='string')fields[field]=v;}
          const i=ledger.addIssue({repo:repo??repoRoot(process.cwd()),title,body,fields,by,from:values.from,goal_id:values.goal,stage:values.stage});out(`${i.id}\t${i.status}\t${i.title}`);return 0;
        }
        if(sub==='brief'){const issue=ledger.getIssue(args[0]??'');if(!issue)throw new Error(`Issue がありません: ${args[0]??''}`);out(assembleIssueBrief(ledger,issue).trimEnd());return 0;}
        if(sub==='show'){const issue=ledger.getIssue(args[0]??'');if(!issue)throw new Error(`Issue がありません: ${args[0]??''}`);out(JSON.stringify({...issue,goal:issue.goal_id?ledger.getGoal(issue.goal_id):null,tasks:ledger.issuesForTask(issue.id)},null,2));return 0;}
        if(sub==='list'){for(const i of ledger.listIssues({repo,goal:values.goal,loose:values.loose}).filter(i=>(!values.by||i.by===values.by)&&(!values.open||i.status==='開いている')))out(`${i.id}\t${i.status}\t${i.title}\t${i.goal_id??''}\t${i.stage??''}\t${i.by}`);return 0;}
        throw new Error('task issue add|list|template|show|brief');
      }
      case 'doc': {
        const [sub]=positionals;
        if(sub==='add'){const kind=values.docKind??values.kind;if(!['仕様','設計','モック','決まり','説明','報告'].includes(kind??''))throw new Error('--kind は 仕様・設計・モック・決まり・説明・報告');const d=ledger.addDoc({repo:repo??repoRoot(process.cwd()),kind:kind as '仕様'|'設計'|'モック'|'決まり'|'説明'|'報告',title:values.title??'',goal_id:values.goal,path:values.path,body:values.body});out(`${d.id}\t${d.kind}\t${d.title}`);return 0;}
        if(sub==='list'){for(const d of ledger.listDocs({repo,goal:values.goal}))out(`${d.id}\t${d.kind}\t${d.title}\t${d.path??''}`);return 0;}
        throw new Error('task doc add|list');
      }
      case 'decision': {const [sub,id]=positionals;if(sub!=='refresh'||positionals.length>2)throw new Error('task decision refresh [<id>]');const count=refreshDecisionCards(ledger,id);out(`${count} 件の判断カードを作り直した`);return 0;}
      case 'priority': {const [id,d]=positionals;if(!id||!['first','up','down'].includes(d??''))throw new Error('task priority <task id> first|up|down');ledger.setPriority(id,d as 'first'|'up'|'down');out(line(ledger.get(id)!));return 0;}
      case 'context': {const task=ledger.get(positionals[0]??'');if(!task)throw new Error(`台帳にありません: ${positionals[0]??''}`);const text=taskContext(ledger,task);if(text)out(text.trimEnd());return 0;}
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
        if (!id || words.length === 0) throw new Error('task answer <id> <答え>');
        const to = (values.to ?? '待ち') as Status;
        const task = answerTask(ledger, id, words.join(' '), to);
        out(line(task));
        if (to !== '確かめ中' && to !== '取り込み中') return 0;
        // Fixed by hand (check, review, merge) or accepted over the review (merge; the check after merging still runs).
        ledger.releaseRunner(task.id);
        for (const said of advance(ledger, task.id, advanceDeps)) out(said);
        for (const said of runOnce(ledger, deps)) out(said);
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
      case 'sweep':
        for (const said of sweepHerdrTabs(ledger, { dryRun: true })) out(said);
        return 0;
      case 'trace': {
        const task = ledger.get(positionals[0] ?? '');
        if (!task) throw new Error(`台帳にありません: ${positionals[0] ?? ''}`);
        out(`${'始まりから'.padStart(8)} ${'かかった'.padStart(8)}    ${task.id}`);
        for (const text of renderTrace(buildTrace(ledger, task))) out(text);
        return 0;
      }
      case 'report': case 'otel': {
        const since = values.since ? new Date(values.since) : null;
        if (since && Number.isNaN(since.getTime())) throw new Error(`--since が日時として読めない: ${values.since}`);
        const traces = tracesSince(ledger, since, repo);
        if (command === 'report') { if (values.json) out(JSON.stringify(traces.map(({task,spans})=>({task,spans})))); else for (const text of report(traces)) out(text); return 0; }
        const path = values.out ?? join(dirname(defaultPath()), 'traces', `task-ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(toOtlp(traces)));
        out(`${traces.length} 件の仕事を書き出した: ${path}`);
        return 0;
      }
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
