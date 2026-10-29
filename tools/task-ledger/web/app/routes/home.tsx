import { redirect } from "react-router";
import type { Route } from "./+types/home.js";
import { getLedger } from "../ledger.server.js";
import { projects } from "../goal-tab/server.js";

// The front door opens the project that most needs you: most decisions, then most running work.
export function loader(_: Route.LoaderArgs) {
  const list = [...projects(getLedger())].sort((a, b) => b.waiting - a.waiting || b.running - a.running);
  if (!list.length) return { empty: true };
  throw redirect(`/p/${encodeURIComponent(list[0]!.name)}`);
}
export function meta() { return [{ title: "task-ledger" }]; }
export default function Home() {
  return <main style={{ maxWidth: 720, margin: "3rem auto", padding: "0 1rem" }}><h1>task-ledger</h1><p>台帳にまだ仕事がありません。</p></main>;
}
