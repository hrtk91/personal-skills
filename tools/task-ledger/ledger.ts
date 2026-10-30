// The task ledger: one SQLite file that holds every task across repositories, so nothing written down is forgotten.
// The harness moves tasks along; people and the commanding Claude only add, answer, hold or drop them.
// Design: handoff/task-ledger-design.md
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createDecisionCard, getDecisionCard, type Decision } from './decision/index.ts';

export const STATUSES = ['依頼文待ち', '待ち', '走行中', '確かめ中', 'レビュー中', '取り込み中', '済', '判断待ち', '保留', 'やめ'] as const;
export type Status = typeof STATUSES[number];
export const KINDS = ['処理', '見た目', '調べ'] as const;
export type Kind = typeof KINDS[number];
// A task in one of these holds its files: another task touching the same files must wait.
export const ACTIVE: readonly Status[] = ['走行中', '確かめ中', 'レビュー中', '取り込み中'];
// Whoever must act next when a task is in this state.
const CLOSED: readonly Status[] = ['済', 'やめ'];

export const WORKERS = ['pi', 'codex', 'claude'] as const;
export type Worker = typeof WORKERS[number];
export type Task = {
  id: string; repo: string; title: string; why: string; brief: string | null;
  worker: Worker | null; model: string | null; effort: string | null;
  check: string | null; after: string[]; files: string[]; kind: Kind; deploy: boolean;
  status: Status; note: string | null; attempts: number; agent: string | null; commit: string | null;
  runner: number | null; workdir: string | null; issue_id: string | null; priority: number; created_at: string; updated_at: string;
};
export type Goal = { id: string; repo: string; title: string; why: string; status: '進行中' | '済' | 'やめ'; stages: string[]; position: number; created_at: string };
export const ISSUE_FIELDS = ['なぜ','今の状態','関係する所','やること','やってよいこと','やらないこと','終わりの条件','確かめのコマンド','触るファイル','種類','本番に出すか'] as const;
export type IssueField = typeof ISSUE_FIELDS[number];
export type IssueFields = Partial<Record<IssueField, string>>;
export type Issue = { id: string; repo: string; title: string; body: string; fields: IssueFields; history: string[]; by: 'あなた' | 'Claude' | '作業役' | 'レビュー' | '見張り役'; from: string | null; goal_id: string | null; stage: string | null; position: number; status: '開いている' | '仕事にした' | '済' | 'やめ'; created_at: string };
export type Doc = { id: string; repo: string; kind: '仕様' | '設計' | 'モック' | '決まり' | '説明' | '報告'; title: string; goal_id: string | null; path: string | null; body: string | null; version: number; updated_at: string };
export type NewTask = {
  repo: string; title: string; why: string; brief?: string | null; check?: string | null;
  worker?: Worker | null; model?: string | null; effort?: string | null;
  after?: string[]; files?: string[]; kind?: Kind; deploy?: boolean; issue_id?: string | null;
};
export type Event = { task_id: string; at: string; from_status: Status | null; to_status: Status; note: string | null };
export type SpanAttributes = Record<string, string | number | boolean>;
/** One step inside the harness (a check run, the review, the merge…), for tracing. Design: handoff/task-ledger-trace-design.md */
export type Span = { task_id: string; attempt: number; name: string; start: string; end: string; ok: boolean; attributes: SpanAttributes };

export function defaultPath(): string {
  return process.env.TASK_LEDGER_DB ?? join(homedir(), '.local/share/task-ledger/ledger.sqlite');
}

function spawnDecisionRefresh(id: string, ledgerPath: string): void {
  const command = process.env.TASK_BIN || join(import.meta.dirname, 'bin/task');
  const reportFailure = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`task decision refresh 起動失敗: ${reason.replace(/[\r\n]+/g, ' ')}\n`);
  };
  try {
    const child = spawn(command, ['decision', 'refresh', id], {
      detached: true, stdio: 'ignore', env: { ...process.env, TASK_LEDGER_DB: ledgerPath },
    });
    child.on('error', reportFailure);
    child.unref();
  } catch (error) { reportFailure(error); /* Status changes are already committed. */ }
}

export class Ledger {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly now: () => Date;

  constructor(path = defaultPath(), now: () => Date = () => new Date()) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, why TEXT NOT NULL, brief TEXT,
        "check" TEXT, after_json TEXT NOT NULL DEFAULT '[]', files_json TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT '処理', deploy INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, agent TEXT, "commit" TEXT, runner INTEGER, workdir TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issue_id TEXT, priority REAL NOT NULL DEFAULT 0,
        worker TEXT, model TEXT, effort TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS events(
        task_id TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, note TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS decision_cards(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, entered_at TEXT NOT NULL, json TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,entered_at)) STRICT;
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, at);
      CREATE TABLE IF NOT EXISTS spans(
        task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL, name TEXT NOT NULL,
        start TEXT NOT NULL, "end" TEXT NOT NULL, ok INTEGER NOT NULL, attributes_json TEXT NOT NULL DEFAULT '{}') STRICT;
      CREATE INDEX IF NOT EXISTS spans_task ON spans(task_id, start);
      CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '進行中', stages_json TEXT NOT NULL DEFAULT '["下調べ","設計","モック","サーバー","画面","本番","様子見"]', position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT 'あなた', source TEXT, goal_id TEXT, stage TEXT, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '開いている', created_at TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '{}', history_json TEXT NOT NULL DEFAULT '[]') STRICT;
      CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, goal_id TEXT, path TEXT, body TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_sessions(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('review','worker')), session_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,kind)) STRICT;
      CREATE TABLE IF NOT EXISTS consult_sessions(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('review','worker')), session_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,kind)) STRICT;`);
    const taskColumns = (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((column) => column.name);
    for (const [name, type] of [['runner', 'INTEGER'], ['workdir', 'TEXT'], ['issue_id', 'TEXT'], ['priority', 'REAL NOT NULL DEFAULT 0'], ['worker', 'TEXT'], ['model', 'TEXT'], ['effort', 'TEXT']]) if (!taskColumns.includes(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    // Ledgers made before the harness started tasks itself lack these columns.
    const issueColumns = (this.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((column) => column.name);
    for (const [name, type] of [['fields_json', "TEXT NOT NULL DEFAULT '{}'"], ['history_json', "TEXT NOT NULL DEFAULT '[]'"]]) if (!issueColumns.includes(name)) this.db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${type}`);

  }

  close(): void { this.db.close(); }

  setSessionId(taskId: string, kind: 'review' | 'worker', sessionId: string): void {
    if (!this.get(taskId) || !sessionId.trim()) return;
    this.db.prepare(`INSERT INTO task_sessions(task_id,kind,session_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(task_id,kind) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at`).run(taskId,kind,sessionId.trim(),this.now().toISOString());
  }
  sessionId(taskId: string, kind: 'review' | 'worker'): string | undefined {
    const row=this.db.prepare('SELECT session_id FROM task_sessions WHERE task_id=? AND kind=?').get(taskId,kind) as {session_id:string}|undefined;
    return row?.session_id;
  }
  setConsultSessionId(taskId:string,kind:'review'|'worker',sessionId:string):void {
    if(!this.get(taskId)||!sessionId.trim())return;
    this.db.prepare(`INSERT INTO consult_sessions(task_id,kind,session_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(task_id,kind) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at`).run(taskId,kind,sessionId.trim(),this.now().toISOString());
  }
  consultSessionId(taskId:string,kind:'review'|'worker'):string|undefined {
    const row=this.db.prepare('SELECT session_id FROM consult_sessions WHERE task_id=? AND kind=?').get(taskId,kind) as {session_id:string}|undefined;
    return row?.session_id;
  }

  add(input: NewTask): Task {
    const title = input.title.trim();
    if (!title) throw new Error('title が空です');
    if (!input.why.trim()) throw new Error('why（なぜやるか。ユーザーの言葉と日付）が空です');
    const kind = input.kind ?? '処理';
    if (!KINDS.includes(kind)) throw new Error(`kind は ${KINDS.join('・')} のどれか: ${kind}`);
    if (input.worker != null && !WORKERS.includes(input.worker)) throw new Error(`worker は ${WORKERS.join('・')} のどれか: ${input.worker}`);
    const after = input.after ?? [];
    for (const id of after) if (!this.get(id)) throw new Error(`after の仕事が台帳にありません: ${id}`);
    const id = this.nextId(input.repo);
    const at = this.now().toISOString();
    // Without a brief nobody can run it yet; the commanding Claude is reminded until one is written.
    const status: Status = input.brief?.trim() ? '待ち' : '依頼文待ち';
    const priority = Number((this.db.prepare('SELECT COALESCE(MAX(priority),-1)+1 AS n FROM tasks').get() as { n: number }).n);
    if (input.issue_id && !this.getIssue(input.issue_id)) throw new Error(`Issue が台帳にありません: ${input.issue_id}`);
    this.db.prepare(`INSERT INTO tasks(id,repo,title,why,brief,"check",after_json,files_json,kind,deploy,status,created_at,updated_at,issue_id,priority,worker,model,effort)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.repo, title, input.why.trim(), input.brief?.trim() || null,
      input.check?.trim() || null, JSON.stringify(after), JSON.stringify(input.files ?? []), kind, input.deploy ? 1 : 0, status, at, at, input.issue_id ?? null, priority, input.worker ?? null, input.model?.trim() || null, input.effort?.trim() || null);
    if (input.issue_id) this.db.prepare("UPDATE issues SET status='仕事にした' WHERE id=?").run(input.issue_id);
    this.event(id, null, status, null, at);
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  list(options: { repo?: string; all?: boolean; status?: Status } = {}): Task[] {
    const where: string[] = []; const args: string[] = [];
    if (options.repo) { where.push('repo=?'); args.push(options.repo); }
    if (options.status) { where.push('status=?'); args.push(options.status); }
    else if (!options.all) { where.push(`status NOT IN (${CLOSED.map(() => '?').join(',')})`); args.push(...CLOSED); }
    const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(toTask);
  }

  addGoal(input: { repo: string; title: string; why?: string; stages?: string[] }): Goal {
    const title=input.title.trim(); if(!title) throw new Error('Goal の題が空です'); const id=this.nextEntityId(input.repo,'g'); const at=this.now().toISOString(); const position=Number((this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM goals WHERE repo=?').get(input.repo) as {n:number}).n);
    this.db.prepare('INSERT INTO goals(id,repo,title,why,stages_json,position,created_at) VALUES(?,?,?,?,?,?,?)').run(id,input.repo,title,input.why?.trim()??'',JSON.stringify(input.stages??['下調べ','設計','モック','サーバー','画面','本番','様子見']),position,at); return this.getGoal(id)!;
  }
  listGoals(repo?:string):Goal[]{return (this.db.prepare(`SELECT * FROM goals${repo?' WHERE repo=?':''} ORDER BY repo,position,created_at`).all(...(repo?[repo]:[])) as Record<string,unknown>[]).map(r=>({...r,stages:JSON.parse(String(r.stages_json))} as Goal));}
  getGoal(id:string):Goal|null{return this.listGoals().find(g=>g.id===id)??null;}
  moveGoal(id:string,direction:'up'|'down'|'first'):void{const g=this.getGoal(id);if(!g)throw new Error(`Goal がありません: ${id}`);const a=this.listGoals(g.repo),i=a.findIndex(x=>x.id===id),j=direction==='first'?0:Math.max(0,Math.min(a.length-1,i+(direction==='up'?-1:1)));if(i===j)return;a.splice(j,0,...a.splice(i,1));a.forEach((x,n)=>this.db.prepare('UPDATE goals SET position=? WHERE id=?').run(n,x.id));}
  addIssue(input:{repo:string;title:string;body?:string;fields?:IssueFields;by?:Issue['by'];from?:string;goal_id?:string;stage?:string}):Issue{const title=input.title.trim();if(!title)throw new Error('Issue の題が空です');const id=this.nextEntityId(input.repo,'i'),at=this.now().toISOString(),position=Number((this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM issues WHERE repo=?').get(input.repo) as {n:number}).n);this.db.prepare('INSERT INTO issues(id,repo,title,body,"by",source,goal_id,stage,position,created_at,fields_json,history_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.repo,title,input.body??'',input.by??'あなた',input.from??null,input.goal_id??null,input.stage??null,position,at,JSON.stringify(input.fields??{}),'[]');return this.getIssue(id)!;}
  getIssue(id:string):Issue|null{const r=this.db.prepare('SELECT * FROM issues WHERE id=?').get(id) as Record<string,unknown>|undefined;return r?({...r,from:r.source,fields:JSON.parse(String(r.fields_json??'{}')),history:JSON.parse(String(r.history_json??'[]'))} as Issue):null;}
  addIssueHistory(id:string, entry:string):void{const issue=this.getIssue(id);if(!issue)throw new Error(`Issue がありません: ${id}`);this.db.prepare('UPDATE issues SET history_json=? WHERE id=?').run(JSON.stringify([...issue.history,entry]),id);}
  issuesForTask(id:string):Task[]{return (this.db.prepare('SELECT * FROM tasks WHERE issue_id=? ORDER BY created_at,id').all(id) as Record<string,unknown>[]).map(toTask);}
  listIssues(o:{repo?:string;goal?:string;loose?:boolean}={}):Issue[]{const w:string[]=[],a:string[]=[];if(o.repo){w.push('repo=?');a.push(o.repo)}if(o.goal){w.push('goal_id=?');a.push(o.goal)}if(o.loose)w.push('goal_id IS NULL');return(this.db.prepare(`SELECT * FROM issues${w.length?' WHERE '+w.join(' AND '):''} ORDER BY repo,position,created_at`).all(...a) as Record<string,unknown>[]).map(r=>({...r,from:r.source} as Issue));}
  addDoc(input:{repo:string;kind:Doc['kind'];title:string;goal_id?:string;path?:string;body?:string}):Doc{if(!!input.path===!!input.body)throw new Error('--path または --body を一つ指定してください');const id=this.nextEntityId(input.repo,'d'),at=this.now().toISOString();this.db.prepare('INSERT INTO docs(id,repo,kind,title,goal_id,path,body,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,input.repo,input.kind,input.title.trim(),input.goal_id??null,input.path??null,input.body??null,1,at);return this.getDoc(id)!;}
  getDoc(id:string):Doc|null{const r=this.db.prepare('SELECT * FROM docs WHERE id=?').get(id) as Record<string,unknown>|undefined;return r?r as Doc:null;}
  listDocs(o:{repo?:string;goal?:string}={}):Doc[]{const w:string[]=[],a:string[]=[];if(o.repo){w.push('repo=?');a.push(o.repo)}if(o.goal){w.push('goal_id=?');a.push(o.goal)}return this.db.prepare(`SELECT * FROM docs${w.length?' WHERE '+w.join(' AND '):''} ORDER BY updated_at DESC`).all(...a) as Doc[];}
  setPriority(id:string,direction:'first'|'up'|'down'):void{const t=this.get(id);if(!t)throw new Error(`台帳にありません: ${id}`);if(t.status!=='待ち')throw new Error('待ちの仕事だけ priority を動かせます');const a=this.list({repo:t.repo,status:'待ち'}).sort((x,y)=>x.priority-y.priority||x.created_at.localeCompare(y.created_at)),i=a.findIndex(x=>x.id===id),j=direction==='first'?0:Math.max(0,Math.min(a.length-1,i+(direction==='up'?-1:1)));if(i===j)return;a.splice(j,0,...a.splice(i,1));a.forEach((x,n)=>this.db.prepare('UPDATE tasks SET priority=? WHERE id=?').run(n,x.id));}
  private nextEntityId(repo:string,kind:'g'|'i'|'d'):string{const base=repo.split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'')||'task',table=kind==='g'?'goals':kind==='i'?'issues':'docs',rows=this.db.prepare(`SELECT id FROM ${table} WHERE repo=?`).all(repo) as {id:string}[],re=new RegExp(`^${base}-${kind}(\\d+)$`),n=rows.reduce((m,r)=>Math.max(m,Number(re.exec(r.id)?.[1]??0)),0)+1;return `${base}-${kind}${n}`;}

  events(id: string): Event[] {
    return this.db.prepare('SELECT task_id,at,from_status,to_status,note FROM events WHERE task_id=? ORDER BY at, rowid').all(id) as Event[];
  }

  recordSpan(span: Span): void {
    this.db.prepare('INSERT INTO spans(task_id,attempt,name,start,"end",ok,attributes_json) VALUES(?,?,?,?,?,?,?)')
      .run(span.task_id, span.attempt, span.name, span.start, span.end, span.ok ? 1 : 0, JSON.stringify(span.attributes));
  }

  spans(id: string): Span[] {
    return (this.db.prepare('SELECT task_id,attempt,name,start,"end",ok,attributes_json FROM spans WHERE task_id=? ORDER BY start, rowid').all(id) as Record<string, unknown>[])
      .map((row) => ({ task_id: String(row.task_id), attempt: Number(row.attempt), name: String(row.name), start: String(row.start), end: String(row.end), ok: row.ok === 1, attributes: JSON.parse(String(row.attributes_json)) }));
  }

  /** Changes a task's status, records it, and pushes tasks that depend on a dead end to 判断待ち. */
  setStatus(id: string, status: Status, note: string | null = null, fields: { agent?: string | null; commit?: string | null; attempts?: number; runner?: number | null } = {}): Task {
    if (!STATUSES.includes(status)) throw new Error(`status が不正: ${status}`);
    const task = this.get(id);
    if (!task) throw new Error(`台帳にありません: ${id}`);
    if (status === '保留' && !note?.trim()) throw new Error('保留には理由と、いつ見直すかを書いてください');
    const at = this.now().toISOString();
    const decisionIds: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE tasks SET status=?, note=?, agent=COALESCE(?,agent), "commit"=COALESCE(?,"commit"), attempts=COALESCE(?,attempts), runner=COALESCE(?,runner), updated_at=? WHERE id=?`)
        .run(status, note, fields.agent ?? null, fields.commit ?? null, fields.attempts ?? null, fields.runner ?? null, at, id);
      this.event(id, task.status, status, note, at);
      if (status === 'やめ' || status === '判断待ち') this.blockDependents(id, at, decisionIds);
      if (status === '判断待ち' && task.status !== '判断待ち') decisionIds.unshift(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (this.path !== ':memory:') for (const decisionId of decisionIds) spawnDecisionRefresh(decisionId, this.path);
    return this.get(id)!;
  }

  decisionCard(id:string,enteredAt:string):{json:Decision;model:string}|null { return getDecisionCard(this,id,enteredAt); }

  /** Records who is doing a running task and where, without a status change. */
  setRunner(id: string, fields: { agent?: string | null; runner?: number | null; workdir?: string | null }): Task {
    this.db.prepare('UPDATE tasks SET agent=COALESCE(?,agent), runner=COALESCE(?,runner), workdir=COALESCE(?,workdir), updated_at=? WHERE id=?')
      .run(fields.agent ?? null, fields.runner ?? null, fields.workdir ?? null, this.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Nobody is working on the task now; the next harness pass may pick it up. */
  releaseRunner(id: string): void {
    this.db.prepare('UPDATE tasks SET runner=NULL, updated_at=? WHERE id=?').run(this.now().toISOString(), id);
  }

  /** Takes a task that nobody is working on, in one statement so two passes never both take it. */
  claimRunner(id: string, statuses: readonly Status[], pid: number): boolean {
    const result = this.db.prepare(`UPDATE tasks SET runner=?, updated_at=? WHERE id=? AND runner IS NULL AND status IN (${statuses.map(() => '?').join(',')})`)
      .run(pid, this.now().toISOString(), id, ...statuses);
    return Number(result.changes) === 1;
  }

  /** Adds or replaces the brief; a task waiting for one becomes ready to run. */
  setBrief(id: string, brief: string, check?: string | null): Task {
    const task = this.get(id);
    if (!task) throw new Error(`台帳にありません: ${id}`);
    if (!brief.trim()) throw new Error('依頼文が空です');
    this.db.prepare(`UPDATE tasks SET brief=?, "check"=COALESCE(?,"check"), updated_at=? WHERE id=?`).run(brief.trim(), check?.trim() || null, this.now().toISOString(), id);
    return task.status === '依頼文待ち' ? this.setStatus(id, '待ち', '依頼文が付いた') : this.get(id)!;
  }

  /**
   * The tasks that may start now, oldest first: waiting, every `after` task done, and no file shared with a
   * task that is already running in the same repository. A task with no listed files may touch anything, so it
   * only starts when nothing else in its repository is running, and nothing starts beside it.
   */
  ready(): Task[] {
    const active = this.list().filter((task) => ACTIVE.includes(task.status));
    const picked: Task[] = [];
    for (const task of this.list({ status: '待ち' }).sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
      if (!task.after.every((id) => this.get(id)?.status === '済')) continue;
      const busy = [...active, ...picked].filter((other) => other.repo === task.repo);
      if (busy.some((other) => filesOverlap(task.files, other.files))) continue;
      picked.push(task);
    }
    return picked;
  }

  /**
   * Takes the oldest task that may start now and marks it 走行中, inside one write transaction so that two
   * harness passes running at the same moment never start the same task or two tasks on the same files.
   * `skip` leaves a ready task where it is (for example, look-and-feel work that Claude does by hand).
   */
  claimNext(skip: (task: Task) => boolean = () => false, note: string | null = null): Task | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.ready().find((candidate) => !skip(candidate));
      if (!task) { this.db.exec('COMMIT'); return null; }
      const at = this.now().toISOString();
      this.db.prepare(`UPDATE tasks SET status='走行中', note=?, attempts=attempts+1, updated_at=? WHERE id=?`).run(note, at, task.id);
      this.event(task.id, task.status, '走行中', note, at);
      this.db.exec('COMMIT');
      return this.get(task.id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private blockDependents(id: string, at: string, decisionIds: string[]): void {
    const waiting = this.list().filter((task) => task.after.includes(id) && !CLOSED.includes(task.status) && !ACTIVE.includes(task.status) && task.status !== '判断待ち');
    for (const task of waiting) {
      const note = `先に済むはずの「${this.get(id)!.title}」が止まった`;
      this.db.prepare('UPDATE tasks SET status=?, note=?, updated_at=? WHERE id=?').run('判断待ち', note, at, task.id);
      this.event(task.id, task.status, '判断待ち', note, at);
      decisionIds.push(task.id);
      this.blockDependents(task.id, at, decisionIds);
    }
  }

  private event(id: string, from: Status | null, to: Status, note: string | null, at: string): void {
    this.db.prepare('INSERT INTO events(task_id,at,from_status,to_status,note) VALUES(?,?,?,?,?)').run(id, at, from, to, note);
  }

  private nextId(repo: string): string {
    const base = repo.split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'task';
    const rows = this.db.prepare('SELECT id FROM tasks WHERE id LIKE ?').all(`${base}-%`) as { id: string }[];
    const max = rows.reduce((top, row) => Math.max(top, Number(row.id.slice(base.length + 1)) || 0), 0);
    return `${base}-${max + 1}`;
  }
}

/** Whether two tasks may touch the same file. Paths are compared as files or directory prefixes. */
export function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const norm = (path: string) => path.replace(/^\.\//, '').replace(/\/+$/, '');
  return a.some((x) => b.some((y) => {
    const p = norm(x); const q = norm(y);
    return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
  }));
}

function toTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id), repo: String(row.repo), title: String(row.title), why: String(row.why),
    brief: row.brief === null ? null : String(row.brief), check: row.check === null ? null : String(row.check),
    worker: row.worker == null ? null : String(row.worker) as Worker, model: row.model == null ? null : String(row.model), effort: row.effort == null ? null : String(row.effort),
    after: JSON.parse(String(row.after_json)), files: JSON.parse(String(row.files_json)),
    kind: String(row.kind) as Kind, deploy: row.deploy === 1, status: String(row.status) as Status,
    note: row.note === null ? null : String(row.note), attempts: Number(row.attempts),
    agent: row.agent === null ? null : String(row.agent), commit: row.commit === null ? null : String(row.commit),
    runner: row.runner === null ? null : Number(row.runner), workdir: row.workdir === null ? null : String(row.workdir), issue_id: row.issue_id === null ? null : String(row.issue_id), priority: Number(row.priority), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}
