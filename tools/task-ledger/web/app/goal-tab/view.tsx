import { useState, type ReactNode } from "react";
import type { DecisionItem, GoalRow, GoalTabData, GoalTabIntent, IssueRow, ProjectSummary, QueueItem, StageState, TaskRow, TaskStatus } from "./types.js";
import styles from "./view.module.css";

// The look of the dashboard's Goal tab (handoff/task-dashboard-mock.html). These parts only draw;
// reading and writing the ledger live with the route that uses them.

export type Tone = "run" | "wait" | "ok" | "bad" | "idle" | "rev";

const STATUS_TONE: Record<TaskStatus, Tone> = {
  "待ち": "idle", "走行中": "run", "確かめ中": "run", "レビュー中": "rev", "取り込み中": "run",
  "判断待ち": "wait", "保留": "idle", "済": "ok", "やめ": "bad", "取り下げ": "idle",
};
const RUNNING: TaskStatus[] = ["走行中", "確かめ中", "レビュー中", "取り込み中"];

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${styles.chip} ${styles[`c_${tone}`]}`}>{children}</span>;
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <Chip tone={STATUS_TONE[status] ?? "idle"}>{status}</Chip>;
}

/** "3 分前", "2 時間前", "10/28" — short enough for a phone row. */
export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "いま";
  if (minutes < 60) return `${minutes} 分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 時間前`;
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function where(row: TaskRow): string {
  return [row.goalTitle, row.issueTitle].filter(Boolean).join(" ・ ") || "Goal なし";
}

// A task reads top-down: what is wrong, what we do about it, and where it is now.
const STEPS = ["待ち", "作業", "確かめ", "レビュー", "取り込み"] as const;
const STEP_AT: Partial<Record<TaskStatus, number>> = { "待ち": 0, "走行中": 1, "確かめ中": 2, "レビュー中": 3, "取り込み中": 4, "済": 5 };

/** "タイムライン: 黒のインナーカラーを選ばない" → the area and the rest. Titles without an area stay whole. */
function splitTitle(title: string): { area?: string; text: string } {
  const match = /^([^:：]{1,16})[:：]\s*(.+)$/.exec(title);
  return match ? { area: match[1], text: match[2] } : { text: title };
}

function Steps({ status }: { status: TaskStatus }) {
  const at = STEP_AT[status];
  if (at === undefined) return <StatusChip status={status} />;
  return (
    <ol className={styles.steps} aria-label={`工程: ${status}`}>
      {STEPS.map((step, index) => <li key={step} className={index < at ? styles.stepDone : index === at ? styles.stepNow : undefined}>{step}</li>)}
    </ol>
  );
}

function TaskStory({ title, why, status, meta, steps = true }: { title: string; why?: string; status: TaskStatus; meta?: string; steps?: boolean }) {
  const { area, text } = splitTitle(title);
  return (
    <div className={styles.story}>
      {area ? <span className={styles.area}>{area}</span> : null}
      {why ? <p className={styles.line}><b className={styles.lbl}>困りごと</b><span>{why}</span></p> : null}
      <p className={`${styles.line} ${styles.fix}`}><b className={styles.lbl}>やること</b><span>{text}</span></p>
      <div className={styles.line}>
        <b className={styles.lbl}>いま</b>
        <span className={styles.nowRow}>{steps ? <Steps status={status} /> : <StatusChip status={status} />}{meta ? <span className={styles.s}>{meta}</span> : null}</span>
      </div>
    </div>
  );
}

// ---- the frame around every tab ----

export type DashboardTab = "goals" | "issues" | "docs" | "retro";
const TABS: Array<{ id: DashboardTab; label: string }> = [
  { id: "goals", label: "Goal" }, { id: "issues", label: "Issue" }, { id: "docs", label: "資料" }, { id: "retro", label: "振り返り" },
];

/** Projects down the side (across the top on a phone), the project's name and pulse, and the tab strip. */
export function DashboardShell({ projects, current, tab, hrefFor, tabHref, foot, children }: {
  projects: ProjectSummary[];
  current: ProjectSummary;
  tab: DashboardTab;
  /** The link to a project's page. */
  hrefFor: (project: ProjectSummary) => string;
  tabHref: (tab: DashboardTab) => string;
  /** One line under the projects: when the harness last ran, how busy the PC is. */
  foot?: ReactNode;
  children: ReactNode;
}) {
  const pulse = [
    current.running ? `動いている ${current.running}` : "動いている仕事なし",
    current.waiting ? `あなたの番 ${current.waiting}` : null,
  ].filter(Boolean).join(" ・ ");
  return (
    <div className={styles.app}>
      <nav className={styles.side} aria-label="プロジェクト">
        <div className={styles.brand}>task-ledger</div>
        {/* On a phone the list becomes one picker: 30 names in a sideways strip hide the current one. */}
        <label className={styles.pick}>
          <span className={styles.pickLabel}>プロジェクト</span>
          <select value={hrefFor(current)} onChange={(event) => { window.location.href = event.currentTarget.value; }}>
            {projects.map((project) => (
              <option key={project.repo} value={hrefFor(project)}>
                {project.name}{project.waiting ? `（あなたの番 ${project.waiting}）` : ""}{project.running ? `（動いている ${project.running}）` : ""}
              </option>
            ))}
          </select>
        </label>
        {projects.map((project) => (
          <a key={project.repo} href={hrefFor(project)} className={project.repo === current.repo ? `${styles.proj} ${styles.on}` : styles.proj} aria-current={project.repo === current.repo ? "page" : undefined}>
            {project.name}
            <span className={styles.dots}>
              {project.waiting ? <span className={`${styles.dot} ${styles.dotWait}`} title="あなたの番">{project.waiting}</span> : null}
              {project.running ? <span className={`${styles.dot} ${styles.dotRun}`} title="動いている">{project.running}</span> : null}
            </span>
          </a>
        ))}
        {foot ? <div className={styles.foot}>{foot}</div> : null}
      </nav>
      <main className={styles.main}>
        <header className={styles.top}>
          <h1>{current.name}</h1>
          <span className={styles.pulse}>{pulse}</span>
        </header>
        <nav className={styles.tabs} aria-label="表示">
          {TABS.map((item) => (
            <a key={item.id} href={tabHref(item.id)} className={item.id === tab ? `${styles.tab} ${styles.on}` : styles.tab} aria-current={item.id === tab ? "page" : undefined}>
              {item.label}
              {item.id === "goals" && current.waiting ? <span className={`${styles.dot} ${styles.dotWait}`}>{current.waiting}</span> : null}
            </a>
          ))}
        </nav>
        {children}
      </main>
    </div>
  );
}

/** A tab that has nothing yet. */
export function EmptyTab({ title, note }: { title: string; note: string }) {
  return (
    <section className={styles.section}>
      <h2>{title}</h2>
      <div className={`${styles.card} ${styles.hint}`}>{note}</div>
    </section>
  );
}

// ---- the Goal tab ----

export function GoalTabView({ data, submit, busy, consultHref }: { data: GoalTabData; submit: (intent: GoalTabIntent) => void; busy?: boolean; /** Opens the consultation sidebar for a task. Omitted: no 「相談する」. */ consultHref?: (taskId: string) => string }) {
  const now = Date.parse(data.readAt);
  return (
    <div className={styles.goalTab}>
      <Decisions items={data.decisions} submit={submit} busy={busy} now={now} consultHref={consultHref} />
      <Queue items={data.queue} submit={submit} busy={busy} now={now} />
      <Goals goals={data.goals} submit={submit} busy={busy} />
      <NewGoal submit={submit} busy={busy} />
      <Recent rows={data.recent} now={now} />
    </div>
  );
}

export function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return <h2>{title}{hint ? <span className={styles.h2hint}>{hint}</span> : null}</h2>;
}

// What waits on you: each stop in the fixed shape, with its options.
function Decisions({ items, submit, busy, now, consultHref }: { items: DecisionItem[]; submit: (intent: GoalTabIntent) => void; busy?: boolean; now: number; consultHref?: (taskId: string) => string }) {
  return (
    <section className={styles.section}>
      <SectionHead title="あなたの番" />
      {items.length
        ? items.map((item) => <Decision key={item.taskId} item={item} submit={submit} busy={busy} now={now} consultHref={consultHref} />)
        : <div className={`${styles.card} ${styles.calm}`}>決めることはありません。</div>}
    </section>
  );
}

const FIELD_LABELS: Array<[keyof NonNullable<DecisionItem["fields"]>, string]> = [
  ["goal", "最終的なゴール"], ["how", "どう実現するか"], ["done", "やったこと"], ["undecided", "決められないこと"],
];

function Decision({ item, submit, busy, now, consultHref }: { item: DecisionItem; submit: (intent: GoalTabIntent) => void; busy?: boolean; now: number; consultHref?: (taskId: string) => string }) {
  const recommended = item.options?.findIndex((option) => option.recommended) ?? -1;
  const [choice, setChoice] = useState(Math.max(0, recommended));
  const [memo, setMemo] = useState("");
  const fields = FIELD_LABELS.filter(([key]) => item.fields?.[key]);
  const options = item.options ?? [];
  const send = (to?: "待ち" | "やめ" | "保留") => {
    const picked = options[choice]?.label;
    const text = [picked, memo.trim()].filter(Boolean).join("。") || (to === "やめ" ? "やめる" : to === "保留" ? "保留" : "続けて");
    submit({ intent: "answer", taskId: item.taskId, text, ...(to ? { to } : {}) });
  };
  return (
    <article className={`${styles.card} ${styles.ask}`} aria-label={item.title}>
      <TaskStory title={item.title} why={item.why} status="判断待ち" meta={[item.goalTitle, `${ago(item.at, now)}から`].filter(Boolean).join(" ・ ")} />
      {item.situation ? (
        <>
          <div className={styles.situ}><b className={styles.lbl}>いまの状況</b><p>{item.situation}</p></div>
          <details className={styles.more}><summary>ハーネスが書いた止まった理由</summary><p>{item.question}</p></details>
        </>
      ) : <p className={styles.q}><b className={styles.lbl}>止まった理由</b>{item.question}</p>}
      {fields.length ? (
        <dl className={styles.fmt}>
          {fields.map(([key, label]) => <div key={key} className={styles.fmtRow}><dt>{label}</dt><dd>{item.fields![key]}</dd></div>)}
        </dl>
      ) : null}
      {options.length ? (
        <div className={styles.opts} role="radiogroup" aria-label="選ぶ">
          {options.map((option, index) => (
            <label key={option.label} className={option.recommended ? `${styles.opt} ${styles.rec}` : styles.opt}>
              <input type="radio" name={`answer-${item.taskId}`} checked={choice === index} onChange={() => setChoice(index)} />
              <span className={styles.optText}>
                <span className={styles.optHead}><b>{option.label}</b>{option.recommended ? <span className={styles.recChip}>おすすめ</span> : null}</span>
                {option.detail ? <span className={styles.s}>{option.detail}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      <div className={styles.btns}>
        <input className={styles.t} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder={options.length ? "ひとこと（任意）" : "どうするか（例: この直し方で続けて）"} aria-label="ひとこと" />
        <button type="button" className={`${styles.b} ${styles.pri}`} disabled={busy || (!options.length && !memo.trim())} onClick={() => send()}>{options.length ? "これで決める" : "続けさせる"}</button>
        {consultHref ? <a className={styles.b} href={consultHref(item.taskId)}>相談する</a> : null}
        {options.length ? null : (
          <>
            <button type="button" className={styles.b} disabled={busy} onClick={() => send("保留")}>保留</button>
            <button type="button" className={`${styles.b} ${styles.quiet}`} disabled={busy} onClick={() => send("やめ")}>やめる</button>
          </>
        )}
      </div>
    </article>
  );
}

// The order the harness starts tasks in. Running ones sit on top and cannot move.
function Queue({ items, submit, busy, now }: { items: QueueItem[]; submit: (intent: GoalTabIntent) => void; busy?: boolean; now: number }) {
  const firstMovable = items.findIndex((item) => item.movable);
  // Name the task being waited for by what it does, not by its number.
  const names = new Map(items.map((item) => [item.id, splitTitle(item.title).text]));
  const named = (text: string) => text.replace(/([a-z0-9][a-z0-9-]*-\d+) ?/g, (whole, id: string) => names.has(id) ? `「${names.get(id)}」` : whole);
  return (
    <section className={styles.section}>
      <SectionHead title="次に出る順" hint="上から出ます。入れ替えると次の 3 分の回から効きます" />
      {items.length ? (
        <ol className={`${styles.card} ${styles.queue}`}>
          {items.map((item, index) => (
            <li key={item.id} className={styles.qi}>
              <span className={styles.no}>{index + 1}</span>
              <span className={styles.tt}>
                <TaskStory title={item.title} why={item.why} status={item.status} meta={[
                  RUNNING.includes(item.status) ? [item.worker, item.attempts > 1 ? `${item.attempts} 回目` : null, `${ago(item.updatedAt, now)}から`].filter(Boolean).join(" ・ ") : null,
                  item.blockedBy ? named(item.blockedBy) : item.after.length ? named(`${item.after.join("・")} の後`) : null,
                ].filter(Boolean).join(" ・ ")} />
                {item.lastNote && RUNNING.includes(item.status) && item.attempts > 1 ? (
                  <details className={styles.more}><summary>前の回で戻された理由</summary><p>{item.lastNote}</p></details>
                ) : null}
                {item.goalTitle || item.issueTitle ? <span className={styles.s}>{where(item)}</span> : null}
              </span>
              {item.movable ? (
                <span className={styles.mv}>
                  <button type="button" disabled={busy || index === firstMovable} onClick={() => submit({ intent: "move-task", taskId: item.id, move: "first" })} title="いちばん先に">先に</button>
                  <button type="button" disabled={busy || index === firstMovable} onClick={() => submit({ intent: "move-task", taskId: item.id, move: "up" })} aria-label="上へ">↑</button>
                  <button type="button" disabled={busy || index === items.length - 1} onClick={() => submit({ intent: "move-task", taskId: item.id, move: "down" })} aria-label="下へ">↓</button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : <div className={`${styles.card} ${styles.calm}`}>待っている仕事はありません。</div>}
    </section>
  );
}

const STAGE_CHIP: Partial<Record<StageState, [Tone, string]>> = { cur: ["run", "いまここ"], stuck: ["wait", "止まっている"], done: ["ok", "済"] };

function Goals({ goals, submit, busy }: { goals: GoalRow[]; submit: (intent: GoalTabIntent) => void; busy?: boolean }) {
  return (
    <section className={styles.section}>
      <SectionHead title="Goal" hint="並びが Goal どうしの優先度です" />
      {goals.length
        ? <div className={styles.goals}>{goals.map((goal, index) => <Goal key={goal.id} goal={goal} first={index === 0} last={index === goals.length - 1} open={index === 0} submit={submit} busy={busy} />)}</div>
        : <div className={`${styles.card} ${styles.hint}`}>まだ Goal はありません。下の「新しい Goal」から書けます。Goal に入っていない仕事も、上の「次に出る順」と下の「最近の仕事」に出ます。</div>}
    </section>
  );
}

function Goal({ goal, first, last, open: openAtFirst, submit, busy }: { goal: GoalRow; first: boolean; last: boolean; open: boolean; submit: (intent: GoalTabIntent) => void; busy?: boolean }) {
  const [open, setOpen] = useState(openAtFirst);
  const [view, setView] = useState<"stage" | "issue">("stage");
  const counts: Array<[Tone, string]> = [];
  if (goal.counts.decisions) counts.push(["wait", `あなたの番 ${goal.counts.decisions}`]);
  if (goal.counts.running) counts.push(["run", `動いている ${goal.counts.running}`]);
  if (goal.counts.waiting) counts.push(["idle", `待ち ${goal.counts.waiting}`]);
  if (goal.counts.done) counts.push(["ok", `済 ${goal.counts.done}`]);
  return (
    <div className={open ? `${styles.card} ${styles.goal} ${styles.open}` : `${styles.card} ${styles.goal}`}>
      <div className={styles.head}>
        <button type="button" className={styles.headButton} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={styles.caret} aria-hidden="true">▶</span>
          <span className={styles.name}>{goal.title}</span>
        </button>
        <span className={styles.counts}>
          <span className={styles.mv}>
            <button type="button" disabled={busy || first} onClick={() => submit({ intent: "move-goal", goalId: goal.id, move: "up" })} aria-label="上へ">↑</button>
            <button type="button" disabled={busy || last} onClick={() => submit({ intent: "move-goal", goalId: goal.id, move: "down" })} aria-label="下へ">↓</button>
          </span>
          {counts.map(([tone, text]) => <Chip key={text} tone={tone}>{text}</Chip>)}
        </span>
        {goal.now ? <span className={styles.now}>{goal.now}</span> : null}
        {goal.stages.length ? (
          <span className={styles.stages} aria-label="工程">
            {goal.stages.map((stage) => (
              <span key={stage.name} className={`${styles.stg} ${styles[`stg_${stage.state}`]}`} title={`${stage.name}${STAGE_CHIP[stage.state] ? `（${STAGE_CHIP[stage.state]![1]}）` : ""}`}>
                <span className={styles.bar} /><span className={styles.lb}>{stage.name}</span>
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className={styles.body}>
          {goal.why ? <div className={`${styles.hint} ${styles.why}`}>{goal.why}</div> : null}
          <div className={styles.view} role="group" aria-label="並べ方">
            <button type="button" className={view === "stage" ? styles.on : undefined} aria-pressed={view === "stage"} onClick={() => setView("stage")}>工程ごと</button>
            <button type="button" className={view === "issue" ? styles.on : undefined} aria-pressed={view === "issue"} onClick={() => setView("issue")}>Issue ごと</button>
          </div>
          {view === "stage" ? <ByStage goal={goal} /> : <ByIssue goal={goal} />}
        </div>
      ) : null}
    </div>
  );
}

function Runs({ tasks }: { tasks: IssueRow["tasks"] }) {
  if (!tasks.length) return null;
  return (
    <span className={styles.tasks} title="作業役が走った回">
      {tasks.flatMap((task) => Array.from({ length: Math.max(1, task.attempts) }, (_, index) => {
        const last = index === Math.max(1, task.attempts) - 1;
        const tone = !last ? "bad" : STATUS_TONE[task.status] === "ok" ? "ok" : RUNNING.includes(task.status) ? "run" : task.status === "判断待ち" ? "wait" : task.status === "やめ" ? "bad" : "idle";
        return <i key={`${task.id}-${index}`} className={`${styles.tk} ${styles[`tk_${tone}`]}`} />;
      }))}
    </span>
  );
}

function IssueLine({ issue, sub }: { issue: IssueRow; sub?: string }) {
  const latest = issue.tasks.at(-1);
  return (
    <div className={styles.issue}>
      <span className={styles.who}>{issue.by}</span>
      <span className={styles.tt}>{issue.title}{sub ? <span className={styles.s}>{sub}</span> : null}</span>
      <Runs tasks={issue.tasks} />
      {latest ? <StatusChip status={latest.status} /> : <Chip tone="idle">{issue.status}</Chip>}
    </div>
  );
}

function ByStage({ goal }: { goal: GoalRow }) {
  return (
    <div>
      {goal.stages.map((stage) => {
        const issues = goal.issues.filter((issue) => issue.stage === stage.name);
        const chip = STAGE_CHIP[stage.state];
        return (
          <div key={stage.name} className={styles.phase}>
            <div className={styles.pn}>{stage.name}{chip ? <Chip tone={chip[0]}>{chip[1]}</Chip> : null}</div>
            <div className={styles.issues}>
              {issues.length ? issues.map((issue) => <IssueLine key={issue.id} issue={issue} />) : <div className={styles.empty}>まだ Issue はない</div>}
            </div>
          </div>
        );
      })}
      {goal.issues.some((issue) => !issue.stage || !goal.stages.some((stage) => stage.name === issue.stage)) ? (
        <div className={styles.phase}>
          <div className={styles.pn}>工程なし</div>
          <div className={styles.issues}>
            {goal.issues.filter((issue) => !issue.stage || !goal.stages.some((stage) => stage.name === issue.stage)).map((issue) => <IssueLine key={issue.id} issue={issue} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ISSUE_ORDER: Partial<Record<TaskStatus, number>> = { "判断待ち": 0, "走行中": 1, "確かめ中": 1, "レビュー中": 1, "取り込み中": 1, "保留": 2, "待ち": 3, "済": 4 };

function ByIssue({ goal }: { goal: GoalRow }) {
  const rank = (issue: IssueRow) => { const latest = issue.tasks.at(-1); return latest ? ISSUE_ORDER[latest.status] ?? 9 : 5; };
  const sorted = [...goal.issues].sort((a, b) => rank(a) - rank(b));
  return (
    <div className={`${styles.issues} ${styles.flat}`}>
      {sorted.length ? sorted.map((issue) => <IssueLine key={issue.id} issue={issue} sub={issue.stage} />) : <div className={styles.empty}>まだ Issue はない</div>}
    </div>
  );
}

function NewGoal({ submit, busy }: { submit: (intent: GoalTabIntent) => void; busy?: boolean }) {
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  return (
    <section className={styles.section}>
      <form className={`${styles.card} ${styles.newGoal}`} onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        submit({ intent: "create-goal", title: title.trim(), why: why.trim() });
        setTitle(""); setWhy("");
      }}>
        <b className={styles.formTitle}>新しい Goal</b>
        <input className={styles.t} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="題（何ができるようになればよいか）" aria-label="題" />
        <textarea className={styles.t} value={why} onChange={(event) => setWhy(event.target.value)} placeholder="きっかけの一言や、こうなったら済、があれば" aria-label="きっかけ" />
        <div className={styles.btns}>
          <button type="submit" className={`${styles.b} ${styles.pri}`} disabled={busy || !title.trim()}>Goal を書く</button>
          <span className={styles.hint}>工程と Issue に分けるのは、次に Claude が起きたときに案を出します。</span>
        </div>
      </form>
    </section>
  );
}

function Recent({ rows, now }: { rows: TaskRow[]; now: number }) {
  if (!rows.length) return null;
  return (
    <section className={styles.section}>
      <SectionHead title="最近の仕事" hint="この 7 日に終わった、Goal に入っていない仕事" />
      <ul className={`${styles.card} ${styles.list}`}>
        {rows.map((row) => (
          <li key={row.id} className={styles.li}>
            <span className={styles.grow}>
              <TaskStory title={row.title} why={row.why} status={row.status} steps={false}
                meta={[row.worker, row.attempts > 1 ? `${row.attempts} 回で` : null, ago(row.updatedAt, now)].filter(Boolean).join(" ・ ")} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
