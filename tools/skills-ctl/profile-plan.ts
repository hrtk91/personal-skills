import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Config,
  type HarnessTarget,
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
  notices: string[];
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
  harness: HarnessTarget,
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
    const unknown = Object.keys(record).filter(
      (key) => key !== "description" && key !== "hooks" && key !== "targets",
    );
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
    description: `harnessctlが${harness}用に生成しました。このfileではなく有効なprofileを編集してください。`,
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
  claudeHome: string,
  statePath: string,
  config: Config,
): DesiredPlan {
  const skills = skillMap(config);
  const selectedSkills = profile.skills.map((rawRef) => {
    const ref = normalizeSkillRef(rawRef);
    const skill = skills.get(ref);
    if (!skill) throw new Error(`skillが見つかりません: ${ref}`);
    return { ref, skill };
  });
  const rules = ruleMap(config);
  const selectedRules = profile.rules.map((rawRef) => {
    const ref = normalizeSkillRef(rawRef);
    const rule = rules.get(ref);
    if (!rule) throw new Error(`rulesが見つかりません: ${ref}`);
    return rule;
  });
  const hooks = hookMap(config);
  const selectedHooks = profile.hooks.map((ref) => {
    const hook = hooks.get(ref);
    if (!hook) throw new Error(`hookが見つかりません: ${ref}`);
    return hook;
  });

  const artifacts: GeneratedArtifact[] = [];
  const entries: ManagedEntry[] = [];
  const notices: string[] = [];
  for (const harness of profile.targets) {
    const home = harness === "codex" ? codexHome : claudeHome;
    const skillsTarget = harness === "codex" ? targetDir : join(claudeHome, "skills");
    for (const { ref, skill } of selectedSkills) {
      entries.push({
        harness,
        kind: "skill",
        linkType: "dir",
        ref,
        sourceId: skill.sourceId,
        name: skill.name,
        source: skill.source,
        target: join(skillsTarget, skill.name),
      });
    }

    if (selectedRules.length > 0) {
      const content = mergedRules(
        selectedRules,
        harness === "codex" ? readBaseAgents(codexHome) : "",
      );
      const hash = createHash("sha256").update(content).digest("hex");
      const prefix = harness === "codex" ? "agents" : "claude-rules";
      const source = join(dirname(statePath), "artifacts", `${prefix}-${hash}.md`);
      artifacts.push({ path: source, content });
      entries.push({
        harness,
        kind: "rules",
        linkType: "file",
        ref: `generated:${hash}`,
        sourceId: "generated",
        name: hash,
        source,
        target: harness === "codex"
          ? join(codexHome, "AGENTS.override.md")
          : join(claudeHome, "rules", "harnessctl-personal-skills.md"),
      });
    }

    const supportedHooks = selectedHooks.filter((hook) => hook.targets.includes(harness));
    if (harness === "claude") {
      for (const hook of selectedHooks) {
        if (!hook.targets.includes("claude")) {
          const reason = hook.targets.length === 0
            ? "targetsにClaudeが指定されていません"
            : `対応対象は${hook.targets.join(", ")}です`;
          notices.push(`Claude対象外 hook ${hook.ref}: ${reason}`);
        }
      }
    }

    const packageTargets = new Map<string, string>();
    for (const hook of supportedHooks) {
      const packageTarget = join(home, "managed-hooks", hook.sourceId, hook.name);
      packageTargets.set(hook.ref, packageTarget);
      entries.push({
        harness,
        kind: "hook-package",
        linkType: "dir",
        ref: hook.ref,
        sourceId: hook.sourceId,
        name: hook.name,
        source: hook.source,
        target: packageTarget,
      });
    }

    if (supportedHooks.length > 0) {
      const content = mergedHooks(supportedHooks, packageTargets, harness);
      const hash = createHash("sha256").update(content).digest("hex");
      const source = join(dirname(statePath), "artifacts", `${harness}-hooks-${hash}.json`);
      artifacts.push({ path: source, content });
      entries.push({
        harness,
        kind: harness === "codex" ? "hook-config" : "claude-hook-config",
        linkType: "file",
        ref: `generated:${hash}`,
        sourceId: "generated",
        name: hash,
        source,
        target: harness === "codex" ? join(codexHome, "hooks.json") : join(claudeHome, "settings.json"),
      });
    }
  }
  return { entries, artifacts, notices };
}
