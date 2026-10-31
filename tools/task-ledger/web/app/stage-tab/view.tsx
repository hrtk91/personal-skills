// The stage tab (Claude's part; mock: random-image handoff stage-mock 3 版). A strip of counts per stage on top, then
// one column per stage in pipeline order. Each card shows where it is on the six steps and, while it waits, what for.
// Phones fold each stage from its heading; wide screens keep every column open.
import { useEffect, useState } from "react";
import type { StageName, StageTabData, StageTask, WaitReason } from "./types.js";
import s from "./view.module.css";

const STEPS: StageName[] = ["出す前", "作業", "確かめ", "レビュー", "取り込み", "本番"];
const WORKER: Record<string, string> = { pi: "Pi", codex: "Codex", claude: "Claude" };
const WIDE = "(min-width: 980px)";

function Steps({ position, done }: { position: number; done?: boolean }) {
  return <div className={s.steps} aria-label={`6 つの工程の ${position + 1} つ目`}>{STEPS.map((name, i) =>
    <i key={name} className={done || i < position ? s.d : i === position ? s.c : undefined} />)}</div>;
}

const minutes = (at: string) => Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
const span = (m: number) => m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;

// A predecessor's title without its trailing （…） reason, so a waiting card stays short.
const short = (title: string) => title.replace(/（[^（）]*）\s*$/, "");

function waitText(wait: WaitReason) {
  if (wait.type === "files") return `同じファイル（${wait.files.join("・")}）を触る「${short(wait.title)}」が終わったら`;
  const where = wait.stage === null ? wait.status : wait.stage === "出す前" ? "出す前" : `${wait.stage}中`;
  return `「${short(wait.title)}」（${where}）が済んだら`;
}

function Card({ task }: { task: StageTask }) {
  const waiting = task.stage === "出す前";
  return <article className={s.item}>
    <div className={s.title}>{task.title}</div>
    {waiting
      ? task.waitsFor.length > 0
        ? task.waitsFor.map((w, i) => <p key={`${w.taskId}-${i}`} className={`${s.wait} ${w.type === "files" ? s.files : ""}`}>{waitText(w)}</p>)
        : <p className={s.why}>{task.status === "依頼文待ち" ? "依頼文を待っています。" : "次の 3 分の見回りで出ます。"}</p>
      : task.why && <p className={s.why}>{task.why}</p>}
    <Steps position={task.position} />
    <div className={s.meta}>
      {!waiting && <span>{task.stage} {span(minutes(task.enteredAt))}</span>}
      {task.stage === "作業" && <span>{WORKER[task.worker] ?? task.worker}{task.model ? `・${task.model}` : ""}</span>}
      {task.attempts >= 2 && <span className={s.redo}>{task.attempts} 回目</span>}
      {task.deploy && <span>本番に出す</span>}
    </div>
  </article>;
}

const time = (at: string) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

export function StageTabView({ data }: { data: StageTabData }) {
  const by = (name: StageName) => data.stages.find(x => x.name === name)?.tasks ?? [];
  const before = by("出す前"), work = by("作業");
  const middle = [...by("確かめ"), ...by("レビュー"), ...by("取り込み")];
  const [wide, setWide] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  useEffect(() => { const m = matchMedia(WIDE); const sync = () => setWide(m.matches); sync(); m.addEventListener("change", sync); return () => m.removeEventListener("change", sync); }, []);
  const col = (id: string, title: string, count: number, hint: string, body: React.ReactNode) =>
    <details id={id} className={s.col} open={wide || !closed[id]} onToggle={e => { if (!wide) { const open = (e.currentTarget as HTMLDetailsElement).open; setClosed(c => c[id] === !open ? c : { ...c, [id]: !open }); } }}>
      <summary onClick={e => { if (wide) e.preventDefault(); }}><h2>{title}</h2><span className={s.n}>{count}</span></summary>
      <div className={s.body}><p className={s.hint}>{hint}</p>{body}</div>
    </details>;
  const jump = (id: string) => () => setClosed(c => ({ ...c, [id]: false }));
  const strip: Array<[string, StageName | "今日 本番", number]> = [
    ["s-before", "出す前", before.length], ["s-work", "作業", work.length], ["s-mid", "確かめ", by("確かめ").length],
    ["s-mid", "レビュー", by("レビュー").length], ["s-mid", "取り込み", by("取り込み").length], ["s-done", "今日 本番", data.production.length],
  ];
  return <section className={s.stageTab}>
    <nav className={s.strip} aria-label="工程ごとの数">{strip.map(([id, name, n]) =>
      <a key={name} href={`#${id}`} onClick={jump(id)} className={n === 0 ? s.zero : name === "作業" ? s.live : name === "今日 本番" ? s.fin : undefined}><b>{n}</b><small>{name}</small></a>)}</nav>
    <div className={s.stopline}><span>止まっている（判断待ち） <b>{data.outside.decisions}</b></span><span>保留 {data.outside.held}</span><span>やめ 今日 {data.outside.stoppedToday}</span></div>
    <div className={s.board}>
      {col("s-before", "出す前", before.length, "先の仕事が済むか、同じファイルを触る仕事が終わるのを待っています。",
        before.length ? before.map(t => <Card key={t.id} task={t} />) : <div className={s.empty}>いまは無し。</div>)}
      {col("s-work", "作業", work.length, "作業役が直しています。",
        work.length ? work.map(t => <Card key={t.id} task={t} />) : <div className={s.empty}>いまは無し。</div>)}
      {col("s-mid", "確かめ・レビュー・取り込み", middle.length, "検査を流す → Opus が差分を読む → 本体に入れて本番に出す。",
        middle.length ? middle.map(t => <Card key={t.id} task={t} />) : <div className={s.empty}>いまは無し。作業が終わると、ここを数分で通ります。</div>)}
      {col("s-done", "今日 本番に出した", data.production.length, "今日、本体に入れた仕事です。",
        data.production.length ? [...data.production].reverse().map(t => <article key={t.id} className={`${s.item} ${s.fin}`}>
          <div className={s.title}>{t.title}</div>
          <Steps position={5} done />
          <div className={s.meta}><span>{time(t.at)} {t.deploy ? "本番" : "取り込んだ（本番には出さない仕事）"}</span></div>
        </article>) : <div className={s.empty}>今日はまだ無し。</div>)}
    </div>
  </section>;
}
