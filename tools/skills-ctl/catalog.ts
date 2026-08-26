import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Config,
  type HarnessInfo,
  type HookInfo,
  type Options,
  type SkillInfo,
  readConfig,
  safeLstat,
  sourceRootPath,
  sourceSkillsPath,
  validateSourceId,
  writeJson,
} from "./model.ts";

export function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function frontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? stripYamlScalar(match[1]) : "";
}

export function discoverSkillsFromSource(sourceId: string, configuredPath: string): SkillInfo[] {
  const skillsRoot = sourceSkillsPath(configuredPath);
  if (!existsSync(skillsRoot)) return [];

  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const source = join(skillsRoot, entry.name);
      const skillFile = join(source, "SKILL.md");
      if (!existsSync(skillFile)) return null;
      const content = readFileSync(skillFile, "utf8");
      const name = frontmatterValue(content, "name") || entry.name;
      return {
        ref: `${sourceId}:${name}`,
        sourceId,
        name,
        description: frontmatterValue(content, "description"),
        source,
      } satisfies SkillInfo;
    })
    .filter((skill): skill is SkillInfo => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverHarnessesFromSource(sourceId: string, configuredPath: string): HarnessInfo[] {
  const root = join(sourceRootPath(configuredPath), "harnesses");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const source = join(root, entry.name, "AGENTS.md");
      if (!existsSync(source)) return null;
      return {
        ref: `${sourceId}:${entry.name}`,
        sourceId,
        name: entry.name,
        source,
      } satisfies HarnessInfo;
    })
    .filter((entry): entry is HarnessInfo => entry !== null)
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

export function discoverHooksFromSource(sourceId: string, configuredPath: string): HookInfo[] {
  const root = join(sourceRootPath(configuredPath), "hooks");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const source = join(root, entry.name);
      const config = join(source, "hooks.json");
      if (!existsSync(config)) return null;
      return {
        ref: `${sourceId}:${entry.name}`,
        sourceId,
        name: entry.name,
        source,
        config,
      } satisfies HookInfo;
    })
    .filter((entry): entry is HookInfo => entry !== null)
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

export function discoverSkills(config: Config): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const [sourceId, source] of Object.entries(config.sources)) {
    skills.push(...discoverSkillsFromSource(sourceId, source.path));
  }
  return skills.sort((left, right) => left.ref.localeCompare(right.ref));
}

export function skillMap(config: Config): Map<string, SkillInfo> {
  const map = new Map<string, SkillInfo>();
  for (const skill of discoverSkills(config)) {
    if (map.has(skill.ref)) throw new Error(`skill参照が重複しています: ${skill.ref}`);
    map.set(skill.ref, skill);
  }
  return map;
}

export function harnessMap(config: Config): Map<string, HarnessInfo> {
  const map = new Map<string, HarnessInfo>();
  for (const [sourceId, source] of Object.entries(config.sources)) {
    for (const harness of discoverHarnessesFromSource(sourceId, source.path)) {
      if (map.has(harness.ref)) throw new Error(`harness参照が重複しています: ${harness.ref}`);
      map.set(harness.ref, harness);
    }
  }
  return map;
}

export function hookMap(config: Config): Map<string, HookInfo> {
  const map = new Map<string, HookInfo>();
  for (const [sourceId, source] of Object.entries(config.sources)) {
    for (const hook of discoverHooksFromSource(sourceId, source.path)) {
      if (map.has(hook.ref)) throw new Error(`hook参照が重複しています: ${hook.ref}`);
      map.set(hook.ref, hook);
    }
  }
  return map;
}

export function deriveSourceId(path: string): string {
  const skillsRoot = sourceSkillsPath(path);
  const resolved = resolve(skillsRoot);
  const candidate = basename(resolved) === "skills"
    ? basename(dirname(resolved))
    : basename(resolved);
  const sourceId = candidate || "source";
  validateSourceId(sourceId);
  return sourceId;
}

export function addSource(path: string, requestedId: string | undefined, options: Options): void {
  const config = readConfig(options.configPath);
  const skillsRoot = sourceSkillsPath(path);
  const stat = safeLstat(skillsRoot);
  if (!stat?.isDirectory()) {
    throw new Error(`source directoryが見つかりません: ${skillsRoot}`);
  }

  const sourceId = requestedId ?? deriveSourceId(skillsRoot);
  validateSourceId(sourceId);
  const normalizedPath = resolve(sourceRootPath(path));
  const existing = config.sources[sourceId];
  if (existing) {
    const existingPath = resolve(sourceRootPath(existing.path));
    if (existingPath !== normalizedPath) {
      throw new Error(
        `source idは登録済みです: ${sourceId} -> ${existingPath}; 別のidを--idで指定してください`,
      );
    }
    console.log(`sourceは登録済みです: ${sourceId} -> ${normalizedPath}`);
    return;
  }

  config.sources[sourceId] = { path: normalizedPath };
  writeJson(options.configPath, config);
  console.log(`sourceを追加しました: ${sourceId} -> ${normalizedPath}`);
}

export function printSourceList(config: Config): void {
  for (const [sourceId, source] of Object.entries(config.sources).sort(([left], [right]) => left.localeCompare(right))) {
    const root = sourceRootPath(source.path);
    const skills = discoverSkillsFromSource(sourceId, source.path).length;
    const harnesses = discoverHarnessesFromSource(sourceId, source.path).length;
    const hooks = discoverHooksFromSource(sourceId, source.path).length;
    console.log(`${sourceId}\t${root}\tskill ${skills}件, harness ${harnesses}件, hook ${hooks}件`);
  }
}
