// 価値基準: whether asking you is getting rarer, and the principles Claude decides by (this project's values first).
import { useLoaderData } from "react-router";
import type { Route } from "./+types/values.js";
import { valueDashboardData } from "../../../answer-data.ts";
import { frameData } from "./frame.server.js";
import { Frame } from "./frame.js";
import { principleSources } from "./principles.server.js";
import s from "./pages.module.css";

export function loader({ params }: Route.LoaderArgs) {
  const { ledger, repo, frame } = frameData(params.name);
  const src = principleSources(repo);
  const ids = new Set(ledger.list({ repo, all: true }).map((t) => t.id));
  const rows = ledger.answersSince("0000-01-01T00:00:00.000Z").filter((a) => ids.has(String(a.task_id)));
  const data = valueDashboardData(src.common, src.local, src.repoName, rows as Array<{ at: string; by: string }>);
  const today = new Date().toLocaleDateString("sv-SE");
  const usedToday = new Map<string, number>();
  for (const a of rows) if (a.principle && new Date(String(a.at)).toLocaleDateString("sv-SE") === today) usedToday.set(String(a.principle), (usedToday.get(String(a.principle)) ?? 0) + 1);
  const days = [...new Set(data.daily.map((d) => d.day))].sort().slice(-14).map((day) => ({
    day, claude: data.daily.find((d) => d.day === day && d.by === "Claude")?.count ?? 0, you: data.daily.find((d) => d.day === day && d.by === "あなた")?.count ?? 0,
  }));
  const withUse = data.principles.map((p) => ({ ref: p.ref, title: p.title, used: usedToday.get(p.ref) ?? 0 }));
  return {
    frame, days, repoName: src.repoName,
    values: withUse.filter((p) => p.ref.startsWith(`${src.repoName}:価値基準`)),
    local: withUse.filter((p) => p.ref.startsWith(`${src.repoName}:`) && !p.ref.startsWith(`${src.repoName}:価値基準`)),
    common: withUse.filter((p) => p.ref.startsWith("共通:")),
  };
}
export function meta() { return [{ title: "価値基準 - task-ledger" }]; }

function PrincipleList({ title, items, empty }: { title: string; items: Array<{ ref: string; title: string; used: number }>; empty: string }) {
  return (
    <section className={s.part}>
      <h2>{title} <span className={s.n}>{items.length}</span></h2>
      {items.length ? (
        <ol className={s.principles}>
          {items.map((p) => <li key={p.ref}><span>{p.title}</span>{p.used ? <span className={s.used}>今日 {p.used} 回使った</span> : null}</li>)}
        </ol>
      ) : <p className={s.empty}>{empty}</p>}
    </section>
  );
}

export default function Values() {
  const { frame, days, repoName, values, local, common } = useLoaderData<typeof loader>();
  return (
    <Frame frame={frame} tab="values">
      <section className={s.part}>
        <h2>聞いた回数と、自分で決めた回数</h2>
        {days.length ? (
          <div className={s.trend}>
            <div className={s.trendHead}><span /><span>自分で決めた</span><span>あなたに聞いた</span></div>
            {days.map((d) => (
              <div key={d.day} className={s.trendRow}>
                <span>{d.day.slice(5).replace("-", "/")}</span>
                <span><i className={s.barClaude} style={{ width: `${Math.min(100, d.claude * 6)}%` }} />{d.claude}</span>
                <span><i className={s.barYou} style={{ width: `${Math.min(100, d.you * 6)}%` }} />{d.you}</span>
              </div>
            ))}
          </div>
        ) : <p className={s.empty}>まだ記録がありません。答えた人の記録は 10/31 から始まりました。</p>}
      </section>
      <PrincipleList title={`${repoName} の価値基準`} items={values} empty="このプロジェクトの PRINCIPLES.md に「大事な価値基準」がありません。" />
      {local.length ? <PrincipleList title={`${repoName} の原則`} items={local} empty="" /> : null}
      <PrincipleList title="共通の原則" items={common} empty="共通の原則のファイルが読めません。" />
    </Frame>
  );
}
