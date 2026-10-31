// The principle files the dashboard shows and Claude answers by: the common one, and the project's PRINCIPLES.md.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parsePrinciples } from "../../../principles.ts";

const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

export function principleSources(repo: string) {
  const common = read(join(homedir(), ".claude/rules/principles.md"));
  const local = read(join(repo, "PRINCIPLES.md"));
  const repoName = basename(repo);
  return { common, local, repoName, all: [...parsePrinciples(common, "共通"), ...parsePrinciples(local, repoName)] };
}
