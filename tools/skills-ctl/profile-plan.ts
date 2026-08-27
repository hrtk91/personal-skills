import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Config,
  type HookInfo,
  type ManagedEntry,
  type Profile,
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
    description: "skillsctlが生成しました。このfileではなく有効なprofileを編集してください。",
    hooks,
  }, null, 2)}\n`;
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

  if (profile.rules) {
    const rules = ruleMap(config).get(profile.rules);
    if (!rules) throw new Error(`rulesが見つかりません: ${profile.rules}`);
    entries.push({
      kind: "rules",
      linkType: "file",
      ref: rules.ref,
      sourceId: rules.sourceId,
      name: rules.name,
      source: rules.source,
      target: join(codexHome, "AGENTS.md"),
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

  const artifacts: GeneratedArtifact[] = [];
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
