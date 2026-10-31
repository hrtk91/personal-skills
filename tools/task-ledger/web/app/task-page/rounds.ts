// One task's history as rounds: each round starts when the harness hands the task to a worker and ends where it
// went next (sent back, stopped for a decision, merged). The round's reflection is why it ended that way and what
// the reviewer left for later. Pure: events and spans in, rounds out.
import type { Event, Span } from "../../../ledger.ts";

export interface RunModel { agent: string; model: string | null; effort: string | null }
export type RoundEnd = "差し戻し" | "判断待ち" | "取り込んだ" | "やめ" | "保留" | "進行中";
export interface Round {
  number: number;
  start: string;
  /** The steps the task passed in this round, in order (作る → 確かめ → レビュー …). */
  steps: string[];
  end: RoundEnd;
  /** Why it was sent back, put on hold or dropped, as the harness wrote it. */
  reason: string | null;
  /** Each stop for a decision in this round, with the answer that let it go on (null while unanswered). */
  stops: Array<{ reason: string | null; answer: string | null }>;
  /** What the reviewer left for later when it passed. */
  leftovers: string[];
  deployed: boolean;
  worker: RunModel | null;
  reviewer: RunModel | null;
}

const STEP: Partial<Record<string, string>> = { "確かめ中": "確かめ", "レビュー中": "レビュー", "取り込み中": "取り込み" };

/** The JSON list after 「残りにした指摘: 」, or nothing when the note has none or it does not parse. */
export function leftoversIn(note: string | null): string[] {
  const at = note?.indexOf("残りにした指摘: ") ?? -1;
  if (!note || at < 0) return [];
  try {
    const list = JSON.parse(note.slice(at + "残りにした指摘: ".length));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

const after = (note: string | null, prefix: string) => note?.startsWith(prefix) ? note.slice(prefix.length).trim() : note?.trim() || null;

function modelOf(spans: Span[], role: string, from: string, to: string | null): RunModel | null {
  const span = spans.filter((s) => s.attributes["model.role"] === role && s.start >= from && (to === null || s.start < to)).at(-1);
  if (!span) return null;
  const text = (key: string) => typeof span.attributes[key] === "string" ? span.attributes[key] as string : null;
  return { agent: text("model.agent") ?? "記録なし", model: text("model.model"), effort: text("model.effort") };
}

export function roundsFor(events: Event[], spans: Span[]): Round[] {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const starts = ordered.flatMap((e, i) => e.to_status === "走行中" && e.from_status !== "走行中" ? [i] : []);
  return starts.map((startIndex, n) => {
    const stop = starts[n + 1] ?? ordered.length;
    const mine = ordered.slice(startIndex, stop);
    const round: Round = {
      number: n + 1, start: mine[0]!.at, steps: [n === 0 ? "作る" : "直す"], end: "進行中", reason: null, stops: [],
      leftovers: [], deployed: false,
      worker: modelOf(spans, "作業役", mine[0]!.at, ordered[stop]?.at ?? null),
      reviewer: modelOf(spans, "レビュー役", mine[0]!.at, ordered[stop]?.at ?? null),
    };
    for (const [i, e] of mine.entries()) {
      if (i === 0) continue;
      const step = STEP[e.to_status];
      if (step && round.steps.at(-1) !== step) round.steps.push(step);
      if (e.from_status === "レビュー中" && e.to_status === "取り込み中") round.leftovers = leftoversIn(e.note);
      if (e.to_status === "走行中") continue;
      if (e.to_status === "判断待ち") { round.end = "判断待ち"; round.stops.push({ reason: e.note?.trim() || null, answer: null }); }
      else if (e.from_status === "判断待ち" && round.stops.length) { round.stops.at(-1)!.answer = after(e.note, "答え:"); if (e.to_status !== "待ち") round.end = "進行中"; }
      else if (e.to_status === "済") {
        round.end = "取り込んだ"; round.deployed = e.note?.includes("本番に出した") ?? false;
        round.steps.push(round.deployed ? "本番" : "済");
        const more = leftoversIn(e.note); if (more.length) round.leftovers = more;
      } else if (e.to_status === "やめ" || e.to_status === "保留") { round.end = e.to_status; round.reason = e.note?.trim() || null; }
    }
    // A send-back is written on the event that starts the next round, so read it from there.
    const next = ordered[stop];
    if (next?.note?.startsWith("差し戻し") && round.end === "進行中") { round.end = "差し戻し"; round.reason = after(next.note, "差し戻し:"); }
    return round;
  });
}
