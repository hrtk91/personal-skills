// あなたの番: only what waits on you. The decisions principles could not settle, principle proposals, and the
// decisions Claude made by a principle, to check.
import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/turn.js";
import { answerDashboardData, processAnswerFeedback } from "../../../answer-data.ts";
import { submitIntent } from "../goal-tab/server.js";
import { Decisions } from "../goal-tab/view.js";
import type { GoalTabIntent } from "../goal-tab/types.js";
import { frameData } from "./frame.server.js";
import { Frame } from "./frame.js";
import { principleSources } from "./principles.server.js";
import { Candidates, ClaudeDecisions, type Candidate, type ClaudeDecision } from "./turn-parts.js";

export function loader({ params }: Route.LoaderArgs) {
  const { ledger, repo, goal, frame } = frameData(params.name);
  const data = answerDashboardData(ledger, repo, principleSources(repo).all);
  const candidates: Candidate[] = data.candidates.map((c) => ({ id: Number(c.id), target: String(c.target), text: String(c.text), quote: String(c.quote), quoteAt: c.quote_at ? String(c.quote_at) : null }));
  const claude: ClaudeDecision[] = (data.answers as Array<Record<string, unknown> & { principle_title: string | null }>).map((a) => ({
    taskId: String(a.task_id), taskTitle: ledger.get(String(a.task_id))?.title ?? String(a.task_id), at: String(a.at), text: String(a.text).replace(/^Claude:\s*/, ""),
    principle: a.principle ? String(a.principle) : null, principleTitle: a.principle_title ?? null,
  })).reverse();
  return { frame, decisions: goal.decisions, readAt: goal.readAt, candidates, claude };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { ledger, repo } = frameData(params.name);
  const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
  if (form.intent === "principle") {
    processAnswerFeedback(ledger, { taskId: "", answerAt: "", action: form.action as "入れる" | "直して入れる" | "入れない", candidateId: Number(form.candidateId), finalText: form.finalText });
  } else if (form.intent === "feedback") {
    processAnswerFeedback(ledger, { taskId: form.taskId!, answerAt: form.answerAt!, action: "違う", note: form.note });
  } else submitIntent(ledger, repo, form);
  return { ok: true };
}
export function meta() { return [{ title: "あなたの番 - task-ledger" }]; }

export default function Turn() {
  const { frame, decisions, readAt, candidates, claude } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data) void revalidator.revalidate(); }, [fetcher.state, fetcher.data, revalidator]);
  const busy = fetcher.state !== "idle";
  const submit = (form: Record<string, string>) => fetcher.submit(form, { method: "post" });
  return (
    <Frame frame={frame} tab="turn">
      <Decisions items={decisions} busy={busy} now={Date.parse(readAt)}
        submit={(intent: GoalTabIntent) => fetcher.submit(intent as unknown as Record<string, string>, { method: "post" })} />
      <Candidates items={candidates} submit={submit} busy={busy} />
      <ClaudeDecisions items={claude} submit={submit} busy={busy} />
    </Frame>
  );
}
