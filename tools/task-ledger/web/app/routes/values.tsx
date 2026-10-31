// 価値基準: the principles learned from your answers, and whether asking is getting rarer. Data comes with
// personal-skills-55 (answers, principle files); until then the page says so.
import { useLoaderData } from "react-router";
import type { Route } from "./+types/values.js";
import { frameData } from "./frame.server.js";
import { Frame } from "./frame.js";
import s from "./pages.module.css";

export function loader({ params }: Route.LoaderArgs) { return { frame: frameData(params.name).frame }; }
export function meta() { return [{ title: "価値基準 - task-ledger" }]; }
export default function Values() {
  const { frame } = useLoaderData<typeof loader>();
  return <Frame frame={frame} tab="values"><p className={s.empty}>原則の一覧は準備中です。</p></Frame>;
}
