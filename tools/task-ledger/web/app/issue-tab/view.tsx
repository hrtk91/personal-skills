// The Issue tab (Claude's part). Each Goal's Issues in its order, then the loose ones; under each Issue, the
// tasks made from it. Closed Issues fold away so the open ones stay on one phone screen.
import type { IssueGroup, IssueRow, IssueStatus, IssueTabData } from "./types.js";
import { Chip, SectionHead, StatusChip, ago, type Tone } from "../goal-tab/view.js";
import base from "../goal-tab/view.module.css";
import styles from "./view.module.css";

const ISSUE_TONE: Record<IssueStatus, Tone> = { "開いている": "wait", "仕事にした": "run", "済": "ok", "やめ": "idle" };
const OPEN = new Set<IssueStatus>(["開いている", "仕事にした"]);

export function IssueTabView({ data, now = Date.now() }: { data: IssueTabData; now?: number }) {
  if (!data.groups.length) {
    return (
      <section className={base.section}>
        <SectionHead title="Issue" />
        <div className={`${base.card} ${base.hint}`}>このプロジェクトには、まだ Issue がありません。Goal を工程に分けたものや、見張り役が見つけた直しがここに並びます。</div>
      </section>
    );
  }
  return <>{data.groups.map((group) => <Group key={group.goalId ?? "loose"} group={group} now={now} />)}</>;
}

function Group({ group, now }: { group: IssueGroup; now: number }) {
  const open = group.issues.filter((i) => OPEN.has(i.status));
  const closed = group.issues.filter((i) => !OPEN.has(i.status));
  const hint = [`開いている ${open.length}`, closed.length ? `閉じた ${closed.length}` : null, group.goalStatus && group.goalStatus !== "進行中" ? group.goalStatus : null].filter(Boolean).join(" ・ ");
  return (
    <section className={base.section}>
      <SectionHead title={group.goalTitle} hint={hint} />
      {open.length ? <ul className={styles.issues}>{open.map((issue) => <Issue key={issue.id} issue={issue} now={now} />)}</ul> : null}
      {closed.length ? (
        <details className={styles.closed}>
          <summary>閉じた Issue（{closed.length} 件）</summary>
          <ul className={styles.issues}>{closed.map((issue) => <Issue key={issue.id} issue={issue} now={now} />)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function Issue({ issue, now }: { issue: IssueRow; now: number }) {
  const meta = [issue.stage ? `工程: ${issue.stage}` : null, `${issue.by}が起こした`, ago(issue.createdAt, now)].filter(Boolean).join(" ・ ");
  return (
    <li className={`${base.card} ${styles.issue}`}>
      <div className={styles.top}>
        <span className={styles.title}>{issue.title}</span>
        <Chip tone={ISSUE_TONE[issue.status] ?? "idle"}>{issue.status}</Chip>
      </div>
      <span className={base.s}>{meta}</span>
      {issue.tasks.length ? (
        <ul className={styles.tasks} aria-label="この Issue から出た仕事">
          {issue.tasks.map((task) => (
            <li key={task.id} className={styles.task}>
              <span className={styles.taskTitle}>{task.title}<span className={base.s}>{task.worker}</span></span>
              <StatusChip status={task.status} />
            </li>
          ))}
        </ul>
      ) : <p className={styles.none}>まだ仕事にしていません。</p>}
      {issue.fields.length ? (
        <details className={styles.fields}>
          <summary>中身を見る</summary>
          <dl>
            {issue.fields.map((f) => <div key={f.label} className={styles.field}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          </dl>
        </details>
      ) : null}
    </li>
  );
}
