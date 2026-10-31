// あなたの番: only what waits on you. Today: the decisions principles could not settle.
import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/turn.js";
import { submitIntent } from "../goal-tab/server.js";
import { Decisions } from "../goal-tab/view.js";
import type { GoalTabIntent } from "../goal-tab/types.js";
import { frameData } from "./frame.server.js";
import { Frame } from "./frame.js";

export function loader({ params }: Route.LoaderArgs) {
  const { goal, frame } = frameData(params.name);
  return { frame, decisions: goal.decisions, readAt: goal.readAt };
}
export async function action({ params, request }: Route.ActionArgs) {
  const { ledger, repo } = frameData(params.name);
  submitIntent(ledger, repo, Object.fromEntries((await request.formData()).entries()) as Record<string, string>);
  return { ok: true };
}
export function meta() { return [{ title: "あなたの番 - task-ledger" }]; }

export default function Turn() {
  const { frame, decisions, readAt } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data) void revalidator.revalidate(); }, [fetcher.state, fetcher.data, revalidator]);
  return (
    <Frame frame={frame} tab="turn">
      <Decisions items={decisions} busy={fetcher.state !== "idle"} now={Date.parse(readAt)}
        submit={(intent: GoalTabIntent) => fetcher.submit(intent as unknown as Record<string, string>, { method: "post" })} />
    </Frame>
  );
}
