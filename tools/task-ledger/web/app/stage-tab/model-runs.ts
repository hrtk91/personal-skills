import type { Span } from "../../../ledger.ts";
import type { ModelRun } from "./types.js";

// 回ごとに、作業役（台本が起動した値）とレビュー役（claude -p に渡した値）を返す。
// 記録が無い回は、既定の値で推測せず「記録なし」の行にする。
export function modelRunsFor(spans: Span[], attempts: number): ModelRun[] {
  const last = Math.max(attempts, ...spans.map(s => s.attempt), 0);
  const runs: ModelRun[] = [];
  for (let attempt = 1; attempt <= last; attempt++) {
    const mine = spans.filter(s => s.attempt === attempt);
    const recorded = (role: ModelRun["role"]) => mine.filter(s => s.attributes["model.role"] === role).at(-1);
    for (const role of ["作業役", "レビュー役"] as const) {
      // 作業役は走った回すべてにある。レビュー役はレビューをした回だけ。
      if (role === "レビュー役" && !mine.some(s => s.name === "レビュー")) continue;
      const span = recorded(role);
      runs.push(span ? fromSpan(span, role) : { role, agent: "記録なし", provider: null, model: null, effort: null, fast: null, attempt, recorded: false });
    }
  }
  return runs;
}

function fromSpan(span: Span, role: ModelRun["role"]): ModelRun {
  const a = span.attributes;
  const text = (key: string) => typeof a[key] === "string" ? a[key] as string : null;
  return { role, agent: text("model.agent") ?? "記録なし", provider: text("model.provider"), model: text("model.model"), effort: text("model.effort"), fast: typeof a["model.fast"] === "boolean" ? a["model.fast"] : null, attempt: span.attempt, recorded: true };
}
