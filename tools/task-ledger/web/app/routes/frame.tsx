// The frame around every project page: the project list, the three tabs, and a refresh every 30 seconds.
import { useEffect, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { DashboardShell, type DashboardTab } from "../goal-tab/view.js";
import type { GoalTabData, ProjectSummary } from "../goal-tab/types.js";

export interface FrameData { projects: ProjectSummary[]; current: ProjectSummary; usage: GoalTabData["claudeUsage"]; last: string | null }

export const projectHref = (name: string) => `/p/${encodeURIComponent(name)}`;
export const tabHref = (name: string, tab: DashboardTab) => tab === "turn" ? projectHref(name) : `${projectHref(name)}/${tab}`;
export const epicHref = (name: string, goalId: string) => `${projectHref(name)}/epic/${encodeURIComponent(goalId)}`;
export const taskHref = (name: string, taskId: string) => `${projectHref(name)}/task/${encodeURIComponent(taskId)}`;

export function Frame({ frame, tab, children }: { frame: FrameData; tab: DashboardTab; children: ReactNode }) {
  const revalidator = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => { if (revalidator.state === "idle") void revalidator.revalidate(); }, 30000);
    return () => clearInterval(id);
  }, [revalidator]);
  const last = frame.last ? new Date(frame.last).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "記録なし";
  return (
    <DashboardShell projects={frame.projects} current={frame.current} tab={tab} usage={frame.usage}
      hrefFor={(p) => projectHref(p.name)} tabHref={(t) => tabHref(frame.current.name, t)}
      foot={`ハーネスは 3 分ごとに回っています。最後: ${last}。`}>
      {children}
    </DashboardShell>
  );
}
