import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillInfo {
  ref: string;
  sourceId: string;
  name: string;
  description: string;
  source: string;
}

export interface RuleInfo {
  ref: string;
  sourceId: string;
  name: string;
  source: string;
}

export interface HookInfo {
  ref: string;
  sourceId: string;
  name: string;
  source: string;
  config: string;
}

export interface Profile {
  description?: string;
  skills: string[];
  rules: string | null;
  hooks: string[];
}

export interface Config {
  version: 3;
  sources: Record<string, SourceConfig>;
  profiles: Record<string, Profile>;
}

export interface SourceConfig {
  path: string;
}

export interface ManagedEntry {
  kind: "skill" | "rules" | "hook-package" | "hook-config";
  linkType: "dir" | "file";
  ref: string;
  sourceId: string;
  name: string;
  source: string;
  target: string;
}

export interface Backup {
  timestamp: string;
  activeProfile: string | null;
  managed: ManagedEntry[];
}

export interface State {
  version: 3;
  codexHome: string;
  targetDir: string;
  activeProfile: string | null;
  managed: ManagedEntry[];
  history: Backup[];
}

export interface Options {
  configPath: string;
  statePath: string;
  codexHome: string;
  targetDir: string;
  sourceId?: string;
  verbose: boolean;
  yes: boolean;
  dryRun: boolean;
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultSourceId = "personal";
export const defaultSourceRoot = repoRoot;

export function defaultConfigPath(): string {
  return process.env.PERSONAL_SKILLS_CONFIG ?? join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "personal-skills",
    "profiles.json",
  );
}

export function defaultStatePath(): string {
  return process.env.PERSONAL_SKILLS_STATE ?? join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "personal-skills",
    "state.json",
  );
}

export function defaultCodexHome(): string {
  return process.env.PERSONAL_SKILLS_CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? join(homedir(), ".codex");
}

export function defaultTargetDir(codexHome: string): string {
  return process.env.PERSONAL_SKILLS_TARGET ?? join(codexHome, "skills");
}

export function parseOptions(args: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const codexHome = defaultCodexHome();
  const options: Options = {
    configPath: defaultConfigPath(),
    statePath: defaultStatePath(),
    codexHome,
    targetDir: defaultTargetDir(codexHome),
    sourceId: undefined,
    verbose: false,
    yes: false,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--config":
        options.configPath = requireOptionValue(args, ++index, arg);
        break;
      case "--state":
        options.statePath = requireOptionValue(args, ++index, arg);
        break;
      case "--target-dir":
        options.targetDir = requireOptionValue(args, ++index, arg);
        break;
      case "--codex-home":
        options.codexHome = requireOptionValue(args, ++index, arg);
        if (!process.env.PERSONAL_SKILLS_TARGET) {
          options.targetDir = join(options.codexHome, "skills");
        }
        break;
      case "--id":
        options.sourceId = requireOptionValue(args, ++index, arg);
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`不明なoptionです: ${arg}`);
        }
        positionals.push(arg);
    }
  }

  return { positionals, options };
}

export function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option}には値が必要です`);
  }
  return value;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`JSONを読み込めません ${path}: ${String(error)}`);
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function emptyConfig(): Config {
  return {
    version: 3,
    sources: { [defaultSourceId]: { path: defaultSourceRoot } },
    profiles: {},
  };
}

export function emptyState(targetDir: string, codexHome: string): State {
  return {
    version: 3,
    codexHome,
    targetDir,
    activeProfile: null,
    managed: [],
    history: [],
  };
}

export function readConfig(path: string): Config {
  const shouldPersistMigration = existsSync(path);
  const config = readJson<Partial<Config>>(path, emptyConfig());
  const version = Number(config.version ?? 1);
  if (version > 3) throw new Error(`未対応のconfig versionです: ${version}`);
  const configuredSources = config.sources ?? {};
  const sources: Record<string, SourceConfig> = {
    [defaultSourceId]: { path: defaultSourceRoot },
    ...configuredSources,
  };
  for (const [id, source] of Object.entries(sources)) {
    validateSourceId(id);
    sources[id] = { path: sourceRootPath(source.path) };
  }
  const profiles = Object.fromEntries(
    Object.entries(config.profiles ?? {}).map(([name, profile]) => [
      name,
      normalizeProfile(profile, name),
    ]),
  );
  const migrated: Config = {
    version: 3,
    sources,
    profiles,
  };
  if (shouldPersistMigration && version < 3) writeJson(path, migrated);
  return migrated;
}

export function readState(path: string, targetDir: string, codexHome: string): State {
  const shouldPersistMigration = existsSync(path);
  const state = readJson<Partial<State>>(path, emptyState(targetDir, codexHome));
  const version = Number(state.version ?? 1);
  if (version > 3) throw new Error(`未対応のstate versionです: ${version}`);
  const managed = (state.managed ?? []).map((entry) => normalizeManagedEntry(entry));
  const history = (state.history ?? []).map((backup) => ({
    timestamp: backup.timestamp,
    activeProfile: backup.activeProfile ?? null,
    managed: (backup.managed ?? []).map((entry) => normalizeManagedEntry(entry)),
  }));
  const migrated: State = {
    version: 3,
    codexHome: state.codexHome ?? codexHome,
    targetDir: state.targetDir ?? targetDir,
    activeProfile: state.activeProfile ?? null,
    managed,
    history,
  };
  if (shouldPersistMigration && version < 3) writeJsonAtomic(path, migrated);
  return migrated;
}

export function normalizeManagedEntry(entry: Partial<ManagedEntry>): ManagedEntry {
  const rawRef = entry.ref ?? `${defaultSourceId}:${entry.name ?? ""}`;
  const ref = rawRef.includes(":") ? rawRef : `${defaultSourceId}:${rawRef}`;
  const separator = ref.indexOf(":");
  const name = entry.name ?? ref.slice(separator + 1);
  return {
    kind: entry.kind ?? "skill",
    linkType: entry.linkType ?? "dir",
    ref,
    sourceId: entry.sourceId ?? ref.slice(0, separator),
    name,
    source: entry.source ?? "",
    target: entry.target ?? "",
  };
}

export function normalizeProfile(profile: Partial<Profile>, name: string): Profile {
  if (!Array.isArray(profile.skills)) {
    throw new Error(`profile ${name}にskills配列がありません`);
  }
  return {
    description: profile.description,
    skills: [...new Set(profile.skills.map(normalizeSkillRef))],
    rules: profile.rules ? normalizeSkillRef(profile.rules) : null,
    hooks: [...new Set((profile.hooks ?? []).map(normalizeSkillRef))],
  };
}

export function expandUserPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function validateSourceId(id: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`source idが不正です: ${id}`);
  }
}

export function sourceSkillsPath(path: string): string {
  const resolved = expandUserPath(path);
  if (resolved.endsWith("/skills") || resolved.endsWith("\\skills")) return resolved;
  const nested = join(resolved, "skills");
  return existsSync(nested) ? nested : resolved;
}

export function sourceRootPath(path: string): string {
  const resolved = expandUserPath(path);
  if (basename(resolved) === "skills") return dirname(resolved);
  return resolved;
}

export function validateSkillName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(":")
  ) {
    throw new Error(`resource名が不正です: ${name}`);
  }
}

export function normalizeSkillRef(value: string): string {
  const separator = value.indexOf(":");
  if (separator === -1) {
    validateSkillName(value);
    return `${defaultSourceId}:${value}`;
  }
  const sourceId = value.slice(0, separator);
  const name = value.slice(separator + 1);
  validateSourceId(sourceId);
  validateSkillName(name);
  return `${sourceId}:${name}`;
}

export function getProfile(config: Config, name: string): Profile {
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`profileが見つかりません: ${name}`);
  }
  return normalizeProfile(profile, name);
}

export function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
