// One task: what the brief asked for, and each round with how it ended and why (the task's own reflection).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/task.js";
import { briefParts } from "../task-page/brief.js";
import { roundsFor, type Round, type RunModel } from "../task-page/rounds.js";
import { goalIdOf } from "./epic.server.js";
import { frameData } from "./frame.server.js";
import { Frame, epicHref, tabHref } from "./frame.js";
import s from "./pages.module.css";

const POSITION: Record<string, number> = { "依頼文待ち": 0, "待ち": 0, "走行中": 1, "確かめ中": 2, "レビュー中": 3, "取り込み中": 4, "済": 6 };

function briefText(repo: string, brief: string | null) {
  if (!brief) return null;
  const path = !brief.includes("\n") && brief.endsWith(".md") ? join(repo, brief) : null;
  return path && existsSync(path) ? readFileSync(path, "utf8") : path ? null : brief;
}

export function loader({ params }: Route.LoaderArgs) {
  const { ledger, repo, frame } = frameData(params.name);
  const task = ledger.get(params.taskId);
  if (!task || task.repo !== repo) throw new Response("Task not found", { status: 404 });
  const goalId = goalIdOf(ledger, task);
  const goal = goalId ? ledger.getGoal(goalId) : null;
  const text = briefText(repo, task.brief);
  return {
    frame, task: { id: task.id, title: task.title, why: task.why.split(/\r?\n/, 1)[0], status: task.status, deploy: task.deploy },
    epic: goal ? { id: goal.id, title: goal.title } : null,
    brief: text ? briefParts(text) : null, briefPath: task.brief && !task.brief.includes("\n") ? task.brief : null,
    rounds: roundsFor(ledger.events(task.id), ledger.spans(task.id)),
  };
}
export function meta({ loaderData }: Route.MetaArgs) { return [{ title: `${loaderData?.task.title ?? "仕事"} - task-ledger` }]; }

const END: Record<Round["end"], string> = { "差し戻し": "差し戻された", "判断待ち": "止まった", "取り込んだ": "取り込んだ", "やめ": "やめた", "保留": "保留にした", "進行中": "いまここ" };
const model = (m: RunModel | null) => m ? [m.agent, m.model, m.effort].filter(Boolean).join("・") : "記録なし";

function RoundCard({ round }: { round: Round }) {
  const end = round.end === "取り込んだ" && round.deployed ? "本番に出した" : END[round.end];
  return (
    <li className={s.round}>
      <div className={s.roundHead}><b>{round.number} 回目</b><span className={`${s.chip} ${s[`end${round.end}`] ?? ""}`}>{end}</span></div>
      <p className={s.flow}>{round.steps.join(" → ")}</p>
      {round.reason ? <Reason text={round.reason} /> : null}
      {round.stops.map((stop, i) => (
        <div key={i} className={s.halt}>
          {stop.reason ? <Reason text={stop.reason} /> : null}
          <p className={s.answer}>{stop.answer ? <>答え: {stop.answer}</> : "答えを待っています"}</p>
        </div>
      ))}
      {round.leftovers.length ? (
        <details className={s.more}><summary>残した指摘（{round.leftovers.length}）</summary><ul>{round.leftovers.map((x, i) => <li key={i}>{x}</li>)}</ul></details>
      ) : null}
      <p className={s.who}>作業役 {model(round.worker)}{round.reviewer ? ` ／ レビュー役 ${model(round.reviewer)}` : ""}</p>
    </li>
  );
}

// Long harness notes open in full on request; the first lines are enough to see what happened.
function Reason({ text }: { text: string }) {
  return text.length > 160
    ? <details className={s.reason}><summary>{text.slice(0, 160)}…</summary><p>{text}</p></details>
    : <p className={s.reason}>{text}</p>;
}

export default function TaskPage() {
  const { frame, task, epic, brief, briefPath, rounds } = useLoaderData<typeof loader>();
  const name = frame.current.name;
  const position = POSITION[task.status];
  return (
    <Frame frame={frame} tab="epic">
      <nav className={s.crumb} aria-label="いまの場所">
        <Link to={tabHref(name, "epic")}>Epic</Link>
        <span><Link to={epicHref(name, epic?.id ?? "all")}>{epic?.title ?? "すべての仕事"}</Link></span>
        <span aria-current="page">仕事</span>
      </nav>
      <section className={s.part}>
        <h2 className={s.taskTitle}>{task.title}</h2>
        <div className={s.now}>
          {position === undefined ? <span className={s.chip}>{task.status}</span>
            : <span className={s.steps} aria-label={task.status}>{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={i < position ? s.d : i === position ? s.c : undefined} />)}</span>}
          <span className={s.metaText}>{task.status}{task.deploy ? "・本番に出す仕事" : ""}</span>
        </div>
      </section>
      <div className={s.two}>
        <section className={s.part}>
          <h2>依頼文</h2>
          <div className={s.brief}>
            {brief && (brief.problem || brief.todo || brief.done) ? <>
              {brief.problem ? <><h3>困りごと</h3><p>{brief.problem}</p></> : null}
              {brief.todo ? <><h3>やること</h3><p>{brief.todo}</p></> : null}
              {brief.done ? <><h3>終わりの条件</h3><p>{brief.done}</p></> : null}
            </> : <p>{task.why || "依頼文がありません。"}</p>}
            {briefPath ? <p className={s.path}>{briefPath}</p> : null}
          </div>
        </section>
        <section className={s.part}>
          <h2>回ごとの振り返り <span className={s.n}>{rounds.length}</span></h2>
          {rounds.length ? <ol className={s.rounds}>{rounds.map((r) => <RoundCard key={r.number} round={r} />)}</ol>
            : <p className={s.empty}>まだ作業役に出していません。</p>}
        </section>
      </div>
    </Frame>
  );
}
