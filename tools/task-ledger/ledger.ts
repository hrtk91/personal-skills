// The task ledger: one SQLite file that holds every task across repositories, so nothing written down is forgotten.
// The harness moves tasks along; people and the commanding Claude only add, answer, hold or drop them.
// Design: handoff/task-ledger-design.md
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const STATUSES = ['依頼文待ち', '待ち', '走行中', '確かめ中', 'レビュー中', '取り込み中', '済', '判断待ち', '保留', 'やめ'] as const;
export type Status = typeof STATUSES[number];
export const KINDS = ['処理', '見た目', '調べ'] as const;
export type Kind = typeof KINDS[number];
// A task in one of these holds its files: another task touching the same files must wait.
export const ACTIVE: readonly Status[] = ['走行中', '確かめ中', 'レビュー中', '取り込み中'];
// Whoever must act next when a task is in this state.
const CLOSED: readonly Status[] = ['済', 'やめ'];

export type Task = {
  id: string; repo: string; title: string; why: string; brief: string | null;
  check: string | null; after: string[]; files: string[]; kind: Kind; deploy: boolean;
  status: Status; note: string | null; attempts: number; agent: string | null; commit: string | null;
  runner: number | null; workdir: string | null; created_at: string; updated_at: string;
};
export type NewTask = {
  repo: string; title: string; why: string; brief?: string | null; check?: string | null;
  after?: string[]; files?: string[]; kind?: Kind; deploy?: boolean;
};
export type Event = { task_id: string; at: string; from_status: Status | null; to_status: Status; note: string | null };

export function defaultPath(): string {
  return process.env.TASK_LEDGER_DB ?? join(homedir(), '.local/share/task-ledger/ledger.sqlite');
}

export class Ledger {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path = defaultPath(), now: () => Date = () => new Date()) {
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
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS events(
        task_id TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, note TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, at);`);
    // Ledgers made before the harness started tasks itself lack these columns.
    const columns = (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((column) => column.name);
    for (const [name, type] of [['runner', 'INTEGER'], ['workdir', 'TEXT']]) if (!columns.includes(name!)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }

  close(): void { this.db.close(); }

  add(input: NewTask): Task {
    const title = input.title.trim();
    if (!title) throw new Error('title が空です');
    if (!input.why.trim()) throw new Error('why（なぜやるか。ユーザーの言葉と日付）が空です');
    const kind = input.kind ?? '処理';
    if (!KINDS.includes(kind)) throw new Error(`kind は ${KINDS.join('・')} のどれか: ${kind}`);
    const after = input.after ?? [];
    for (const id of after) if (!this.get(id)) throw new Error(`after の仕事が台帳にありません: ${id}`);
    const id = this.nextId(input.repo);
    const at = this.now().toISOString();
    // Without a brief nobody can run it yet; the commanding Claude is reminded until one is written.
    const status: Status = input.brief?.trim() ? '待ち' : '依頼文待ち';
    this.db.prepare(`INSERT INTO tasks(id,repo,title,why,brief,"check",after_json,files_json,kind,deploy,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.repo, title, input.why.trim(), input.brief?.trim() || null,
      input.check?.trim() || null, JSON.stringify(after), JSON.stringify(input.files ?? []), kind, input.deploy ? 1 : 0, status, at, at);
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

  events(id: string): Event[] {
    return this.db.prepare('SELECT task_id,at,from_status,to_status,note FROM events WHERE task_id=? ORDER BY at, rowid').all(id) as Event[];
  }

  /** Changes a task's status, records it, and pushes tasks that depend on a dead end to 判断待ち. */
  setStatus(id: string, status: Status, note: string | null = null, fields: { agent?: string | null; commit?: string | null; attempts?: number; runner?: number | null } = {}): Task {
    if (!STATUSES.includes(status)) throw new Error(`status が不正: ${status}`);
    const task = this.get(id);
    if (!task) throw new Error(`台帳にありません: ${id}`);
    if (status === '保留' && !note?.trim()) throw new Error('保留には理由と、いつ見直すかを書いてください');
    const at = this.now().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE tasks SET status=?, note=?, agent=COALESCE(?,agent), "commit"=COALESCE(?,"commit"), attempts=COALESCE(?,attempts), runner=COALESCE(?,runner), updated_at=? WHERE id=?`)
        .run(status, note, fields.agent ?? null, fields.commit ?? null, fields.attempts ?? null, fields.runner ?? null, at, id);
      this.event(id, task.status, status, note, at);
      if (status === 'やめ' || status === '判断待ち') this.blockDependents(id, at);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id)!;
  }

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
    for (const task of this.list({ status: '待ち' })) {
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

  private blockDependents(id: string, at: string): void {
    const waiting = this.list().filter((task) => task.after.includes(id) && !CLOSED.includes(task.status) && !ACTIVE.includes(task.status) && task.status !== '判断待ち');
    for (const task of waiting) {
      const note = `先に済むはずの「${this.get(id)!.title}」が止まった`;
      this.db.prepare('UPDATE tasks SET status=?, note=?, updated_at=? WHERE id=?').run('判断待ち', note, at, task.id);
      this.event(task.id, task.status, '判断待ち', note, at);
      this.blockDependents(task.id, at);
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
    after: JSON.parse(String(row.after_json)), files: JSON.parse(String(row.files_json)),
    kind: String(row.kind) as Kind, deploy: row.deploy === 1, status: String(row.status) as Status,
    note: row.note === null ? null : String(row.note), attempts: Number(row.attempts),
    agent: row.agent === null ? null : String(row.agent), commit: row.commit === null ? null : String(row.commit),
    runner: row.runner === null ? null : Number(row.runner), workdir: row.workdir === null ? null : String(row.workdir), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}
