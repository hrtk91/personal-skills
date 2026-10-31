// What every project page needs for its frame: the project list, the current project, and the quota line.
import { getLedger, lastHarnessTime } from "../ledger.server.js";
import { loadGoalData, projects } from "../goal-tab/server.js";

export function frameData(name: string | undefined) {
  const ledger = getLedger();
  const list = projects(ledger);
  const current = list.find((p) => p.name === name);
  if (!current) throw new Response("Project not found", { status: 404 });
  const goal = loadGoalData(ledger, current.repo);
  return { ledger, repo: current.repo, goal, frame: { projects: list, current, usage: goal.claudeUsage, last: lastHarnessTime() ?? null } };
}
