import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Config,
  type HookInfo,
  type ManagedEntry,
  type Profile,
  type RuleInfo,
  normalizeSkillRef,
} from "./model.ts";
import { hookMap, ruleMap, skillMap } from "./catalog.ts";

export interface GeneratedArtifact {
  path: string;
  content: string;
}

export interface DesiredPlan {
  entries: ManagedEntry[];
  artifacts: GeneratedArtifact[];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function replaceHookRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replaceAll("{{HOOK_ROOT}}", shellQuote(root));
  if (Array.isArray(value)) return value.map((entry) => replaceHookRoot(entry, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, replaceHookRoot(entry, root)]),
    );
  }
  return value;
}

export function mergedHooks(
  selected: HookInfo[],
  packageTargets: Map<string, string>,
): string {
  const hooks: Record<string, unknown[]> = {};
  for (const hook of selected) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(hook.config, "utf8"));
    } catch (error) {
      throw new Error(`hook設定を読み込めません ${hook.config}: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`hook設定はobjectである必要があります: ${hook.config}`);
    }
    const record = parsed as Record<string, unknown>;
    const configuredHooks = record.hooks;
    const unknown = Object.keys(record).filter((key) => key !== "description" && key !== "hooks");
    if (unknown.length > 0) {
      throw new Error(`hook設定に未対応のkeyがあります ${hook.config}: ${unknown.join(", ")}`);
    }
    if (!configuredHooks || typeof configuredHooks !== "object" || Array.isArray(configuredHooks)) {
      throw new Error(`hook設定にhooks objectがありません: ${hook.config}`);
    }
    const root = packageTargets.get(hook.ref)!;
    for (const [event, groups] of Object.entries(configuredHooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) throw new Error(`hook eventは配列である必要があります: ${hook.ref}:${event}`);
      const replaced = replaceHookRoot(groups, root);
      const serialized = JSON.stringify(replaced);
      if (serialized.includes("{{")) {
        throw new Error(`未置換のhook placeholderがあります: ${hook.ref}:${event}`);
      }
      (hooks[event] ??= []).push(...JSON.parse(serialized) as unknown[]);
    }
  }
  return `${JSON.stringify({
    description: "harnessctlが生成しました。このfileではなく有効なprofileを編集してください。",
    hooks,
  }, null, 2)}\n`;
}

export function readBaseAgents(codexHome: string): string {
  const source = join(codexHome, "AGENTS.md");
  if (!existsSync(source)) return "";
  try {
    return readFileSync(source, "utf8");
  } catch (error) {
    throw new Error(`base AGENTS.mdを読み込めません ${source}: ${String(error)}`);
  }
}

export function mergedRules(selected: RuleInfo[], baseContent = ""): string {
  const contents = selected.map((rule) => {
    try {
      const content = readFileSync(rule.source, "utf8");
      return content.endsWith("\n") ? content : `${content}\n`;
    } catch (error) {
      throw new Error(`rulesを読み込めません ${rule.source}: ${String(error)}`);
    }
  });
  const header = "<!-- harnessctlが生成しました。このfileを直接編集せず、AGENTS.mdと有効なprofileを編集してください。 -->";
  const sections = [
    ...(baseContent.length > 0 ? [baseContent.replace(/\n+$/u, "")] : []),
    header,
    ...contents.map((content) => content.replace(/\n+$/u, "")),
  ];
  return `${sections.join("\n\n")}\n`;
}

export function desiredPlan(
  profile: Profile,
  targetDir: string,
  codexHome: string,
  statePath: string,
  config: Config,
): DesiredPlan {
  const skills = skillMap(config);
  const entries: ManagedEntry[] = profile.skills.map((rawRef) => {
    const ref = normalizeSkillRef(rawRef);
    const skill = skills.get(ref);
    if (!skill) throw new Error(`skillが見つかりません: ${ref}`);
    return {
      kind: "skill" as const,
      linkType: "dir" as const,
      ref,
      sourceId: skill.sourceId,
      name: skill.name,
      source: skill.source,
      target: join(targetDir, skill.name),
    };
  });

  const artifacts: GeneratedArtifact[] = [];
  const rules = ruleMap(config);
  const selectedRules = profile.rules.map((rawRef) => {
    const ref = normalizeSkillRef(rawRef);
    const rule = rules.get(ref);
    if (!rule) throw new Error(`rulesが見つかりません: ${ref}`);
    return rule;
  });
  if (selectedRules.length > 0) {
    const content = mergedRules(selectedRules, readBaseAgents(codexHome));
    const hash = createHash("sha256").update(content).digest("hex");
    const source = join(dirname(statePath), "artifacts", `agents-${hash}.md`);
    artifacts.push({ path: source, content });
    entries.push({
      kind: "rules",
      linkType: "file",
      ref: `generated:${hash}`,
      sourceId: "generated",
      name: hash,
      source,
      target: join(codexHome, "AGENTS.override.md"),
    });
  }

  const hooks = hookMap(config);
  const selectedHooks = profile.hooks.map((ref) => {
    const hook = hooks.get(ref);
    if (!hook) throw new Error(`hookが見つかりません: ${ref}`);
    return hook;
  });
  const packageTargets = new Map<string, string>();
  for (const hook of selectedHooks) {
    const target = join(codexHome, "managed-hooks", hook.sourceId, hook.name);
    packageTargets.set(hook.ref, target);
    entries.push({
      kind: "hook-package",
      linkType: "dir",
      ref: hook.ref,
      sourceId: hook.sourceId,
      name: hook.name,
      source: hook.source,
      target,
    });
  }

  if (selectedHooks.length > 0) {
    const content = mergedHooks(selectedHooks, packageTargets);
    const hash = createHash("sha256").update(content).digest("hex");
    const source = join(dirname(statePath), "artifacts", `hooks-${hash}.json`);
    artifacts.push({ path: source, content });
    entries.push({
      kind: "hook-config",
      linkType: "file",
      ref: `generated:${hash}`,
      sourceId: "generated",
      name: hash,
      source,
      target: join(codexHome, "hooks.json"),
    });
  }
  return { entries, artifacts };
}
