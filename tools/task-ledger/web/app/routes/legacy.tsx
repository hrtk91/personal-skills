// The old tab addresses (Goal・Issue・工程・資料・振り返り) open where their content went.
import { redirect } from "react-router";
import type { Route } from "./+types/legacy.js";

const TO: Record<string, string> = { goals: "", issues: "/epic", stage: "/epic/all", docs: "", retro: "" };
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/p/${encodeURIComponent(params.name)}${TO[params.old] ?? ""}`);
}
export default function Legacy() { return null; }
