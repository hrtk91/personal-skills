// Epic: one row per Epic with how far it has got. A row opens that Epic's stage page; 「すべての仕事」 opens every task.
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/epic-list.js";
import { epicList } from "./epic.server.js";
import { frameData } from "./frame.server.js";
import { Frame, epicHref, taskHref } from "./frame.js";
import s from "./pages.module.css";

export function loader({ params }: Route.LoaderArgs) {
  const { ledger, repo, frame } = frameData(params.name);
  return { frame, ...epicList(ledger, repo) };
}
export function meta() { return [{ title: "Epic - task-ledger" }]; }

export default function EpicList() {
  const { frame, epics, all, loose } = useLoaderData<typeof loader>();
  const name = frame.current.name;
  return (
    <Frame frame={frame} tab="epic">
      <section className={s.part}>
        <h2>Epic <span className={s.n}>{epics.length}</span></h2>
        <Link className={s.row} to={epicHref(name, "all")}>
          <span className={s.title}>すべての仕事</span>
          <span className={s.meta}><span>作業 {all.running}</span><span>待ち {all.waiting}</span><span>今日済んだ {all.doneToday}</span></span>
        </Link>
        {epics.map((epic) => (
          <Link key={epic.id} className={s.row} to={epicHref(name, epic.id)}>
            <span className={s.title}>{epic.title}</span>
            <span className={s.prog}>
              <span className={s.track}><i style={{ width: `${epic.total ? Math.round(epic.done / epic.total * 100) : 0}%` }} /></span>
              <span>済 {epic.done} / {epic.total}{epic.stopped ? <b className={s.stop}>止まっている {epic.stopped}</b> : null}</span>
            </span>
          </Link>
        ))}
      </section>
      {loose.length ? (
        <section className={s.part}>
          <h2>Epic に入っていない仕事 <span className={s.n}>{loose.length}</span></h2>
          <div className={s.list}>
            {loose.map((task) => <Link key={task.id} to={taskHref(name, task.id)}><span>{task.title}</span><span className={s.state}>{task.status}</span></Link>)}
          </div>
        </section>
      ) : null}
    </Frame>
  );
}
