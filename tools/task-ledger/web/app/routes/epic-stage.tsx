// One Epic's tasks on the stage board (「すべての仕事」 when the id is all). Cards open the task page.
import { useEffect } from "react";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/epic-stage.js";
import { submitIntent } from "../goal-tab/server.js";
import { loadStageData } from "../stage-tab/server.js";
import { StageTabView } from "../stage-tab/view.js";
import { epicTaskIds, narrowStage } from "./epic.server.js";
import { frameData } from "./frame.server.js";
import { Frame, tabHref, taskHref } from "./frame.js";
import s from "./pages.module.css";

export function loader({ params }: Route.LoaderArgs) {
  const { ledger, repo, frame } = frameData(params.name);
  const goal = params.goalId === "all" ? null : ledger.getGoal(params.goalId);
  if (params.goalId !== "all" && (!goal || goal.repo !== repo)) throw new Response("Epic not found", { status: 404 });
  return { frame, goalId: params.goalId, title: goal?.title ?? "すべての仕事", stage: narrowStage(loadStageData(ledger, repo), epicTaskIds(ledger, repo, params.goalId)) };
}
export async function action({ params, request }: Route.ActionArgs) {
  const { ledger, repo } = frameData(params.name);
  submitIntent(ledger, repo, Object.fromEntries((await request.formData()).entries()) as Record<string, string>);
  return { ok: true };
}
export function meta({ loaderData }: Route.MetaArgs) { return [{ title: `${loaderData?.title ?? "Epic"} - task-ledger` }]; }

export default function EpicStage() {
  const { frame, title, stage } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data) void revalidator.revalidate(); }, [fetcher.state, fetcher.data, revalidator]);
  const name = frame.current.name;
  return (
    <Frame frame={frame} tab="epic">
      <nav className={s.crumb} aria-label="いまの場所"><Link to={tabHref(name, "epic")}>Epic</Link><span aria-current="page">{title}</span></nav>
      <StageTabView data={stage} hrefFor={(id) => taskHref(name, id)}
        onFirst={(id) => fetcher.submit({ intent: "move-task", taskId: id, move: "first" }, { method: "post" })} />
    </Frame>
  );
}
