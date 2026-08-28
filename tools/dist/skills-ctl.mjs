#!/usr/bin/env node

// tools/skills-ctl.ts
import { resolve as resolve4 } from "node:path";

// tools/skills-ctl/model.ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var defaultSourceId = "personal";
var defaultSourceRoot = repoRoot;
function defaultConfigPath() {
  return process.env.PERSONAL_SKILLS_CONFIG ?? join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "personal-skills",
    "profiles.json"
  );
}
function defaultStatePath() {
  return process.env.PERSONAL_SKILLS_STATE ?? join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "personal-skills",
    "state.json"
  );
}
function defaultCodexHome() {
  return process.env.PERSONAL_SKILLS_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}
function defaultTargetDir(codexHome) {
  return process.env.PERSONAL_SKILLS_TARGET ?? join(codexHome, "skills");
}
function parseOptions(args) {
  const positionals = [];
  const codexHome = defaultCodexHome();
  const options = {
    configPath: defaultConfigPath(),
    statePath: defaultStatePath(),
    codexHome,
    targetDir: defaultTargetDir(codexHome),
    sourceId: void 0,
    verbose: false,
    yes: false,
    dryRun: false
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
          throw new Error(`\u4E0D\u660E\u306Aoption\u3067\u3059: ${arg}`);
        }
        positionals.push(arg);
    }
  }
  return { positionals, options };
}
function requireOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option}\u306B\u306F\u5024\u304C\u5FC5\u8981\u3067\u3059`);
  }
  return value;
}
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`JSON\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093 ${path}: ${String(error)}`);
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}
`, "utf8");
}
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  renameSync(temporary, path);
}
function emptyConfig() {
  return {
    version: 3,
    sources: { [defaultSourceId]: { path: defaultSourceRoot } },
    profiles: {}
  };
}
function emptyState(targetDir, codexHome) {
  return {
    version: 3,
    codexHome,
    targetDir,
    activeProfile: null,
    managed: [],
    history: []
  };
}
function readConfig(path) {
  const shouldPersistMigration = existsSync(path);
  const config = readJson(path, emptyConfig());
  const version = Number(config.version ?? 1);
  if (version > 3) throw new Error(`\u672A\u5BFE\u5FDC\u306Econfig version\u3067\u3059: ${version}`);
  const configuredSources = config.sources ?? {};
  const sources = {
    [defaultSourceId]: { path: defaultSourceRoot },
    ...configuredSources
  };
  for (const [id, source] of Object.entries(sources)) {
    validateSourceId(id);
    sources[id] = { path: sourceRootPath(source.path) };
  }
  const profiles = Object.fromEntries(
    Object.entries(config.profiles ?? {}).map(([name, profile]) => [
      name,
      normalizeProfile(profile, name)
    ])
  );
  const migrated = {
    version: 3,
    sources,
    profiles
  };
  if (shouldPersistMigration && version < 3) writeJson(path, migrated);
  return migrated;
}
function readState(path, targetDir, codexHome) {
  const shouldPersistMigration = existsSync(path);
  const state = readJson(path, emptyState(targetDir, codexHome));
  const version = Number(state.version ?? 1);
  if (version > 3) throw new Error(`\u672A\u5BFE\u5FDC\u306Estate version\u3067\u3059: ${version}`);
  const managed = (state.managed ?? []).map((entry) => normalizeManagedEntry(entry));
  const history = (state.history ?? []).map((backup) => ({
    timestamp: backup.timestamp,
    activeProfile: backup.activeProfile ?? null,
    managed: (backup.managed ?? []).map((entry) => normalizeManagedEntry(entry))
  }));
  const migrated = {
    version: 3,
    codexHome: state.codexHome ?? codexHome,
    targetDir: state.targetDir ?? targetDir,
    activeProfile: state.activeProfile ?? null,
    managed,
    history
  };
  if (shouldPersistMigration && version < 3) writeJsonAtomic(path, migrated);
  return migrated;
}
function normalizeManagedEntry(entry) {
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
    target: entry.target ?? ""
  };
}
function normalizeProfile(profile, name) {
  if (!Array.isArray(profile.skills)) {
    throw new Error(`profile ${name}\u306Bskills\u914D\u5217\u304C\u3042\u308A\u307E\u305B\u3093`);
  }
  return {
    description: profile.description,
    skills: [...new Set(profile.skills.map(normalizeSkillRef))],
    rules: profile.rules ? normalizeSkillRef(profile.rules) : null,
    hooks: [...new Set((profile.hooks ?? []).map(normalizeSkillRef))]
  };
}
function expandUserPath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}
function validateSourceId(id) {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`source id\u304C\u4E0D\u6B63\u3067\u3059: ${id}`);
  }
}
function sourceSkillsPath(path) {
  const resolved = expandUserPath(path);
  if (resolved.endsWith("/skills") || resolved.endsWith("\\skills")) return resolved;
  const nested = join(resolved, "skills");
  return existsSync(nested) ? nested : resolved;
}
function sourceRootPath(path) {
  const resolved = expandUserPath(path);
  if (basename(resolved) === "skills") return dirname(resolved);
  return resolved;
}
function validateSkillName(name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":")) {
    throw new Error(`resource\u540D\u304C\u4E0D\u6B63\u3067\u3059: ${name}`);
  }
}
function normalizeSkillRef(value) {
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
function getProfile(config, name) {
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`profile\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${name}`);
  }
  return normalizeProfile(profile, name);
}
function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// tools/skills-ctl/catalog.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function frontmatterValue(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? stripYamlScalar(match[1]) : "";
}
function discoverSkillsFromSource(sourceId, configuredPath) {
  const skillsRoot = sourceSkillsPath(configuredPath);
  if (!existsSync2(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const source = join2(skillsRoot, entry.name);
    const skillFile = join2(source, "SKILL.md");
    if (!existsSync2(skillFile)) return null;
    const content = readFileSync2(skillFile, "utf8");
    const name = frontmatterValue(content, "name") || entry.name;
    return {
      ref: `${sourceId}:${name}`,
      sourceId,
      name,
      description: frontmatterValue(content, "description"),
      source
    };
  }).filter((skill) => skill !== null).sort((left, right) => left.name.localeCompare(right.name));
}
function discoverRulesFromSource(sourceId, configuredPath) {
  const root = join2(sourceRootPath(configuredPath), "rules");
  if (!existsSync2(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const source = join2(root, entry.name, "AGENTS.md");
    if (!existsSync2(source)) return null;
    return {
      ref: `${sourceId}:${entry.name}`,
      sourceId,
      name: entry.name,
      source
    };
  }).filter((entry) => entry !== null).sort((left, right) => left.ref.localeCompare(right.ref));
}
function discoverHooksFromSource(sourceId, configuredPath) {
  const root = join2(sourceRootPath(configuredPath), "hooks");
  if (!existsSync2(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const source = join2(root, entry.name);
    const config = join2(source, "hooks.json");
    if (!existsSync2(config)) return null;
    return {
      ref: `${sourceId}:${entry.name}`,
      sourceId,
      name: entry.name,
      source,
      config
    };
  }).filter((entry) => entry !== null).sort((left, right) => left.ref.localeCompare(right.ref));
}
function discoverSkills(config) {
  const skills = [];
  for (const [sourceId, source] of Object.entries(config.sources)) {
    skills.push(...discoverSkillsFromSource(sourceId, source.path));
  }
  return skills.sort((left, right) => left.ref.localeCompare(right.ref));
}
function skillMap(config) {
  const map = /* @__PURE__ */ new Map();
  for (const skill of discoverSkills(config)) {
    if (map.has(skill.ref)) throw new Error(`skill\u53C2\u7167\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${skill.ref}`);
    map.set(skill.ref, skill);
  }
  return map;
}
function ruleMap(config) {
  const map = /* @__PURE__ */ new Map();
  for (const [sourceId, source] of Object.entries(config.sources)) {
    for (const rules of discoverRulesFromSource(sourceId, source.path)) {
      if (map.has(rules.ref)) throw new Error(`rules\u53C2\u7167\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${rules.ref}`);
      map.set(rules.ref, rules);
    }
  }
  return map;
}
function hookMap(config) {
  const map = /* @__PURE__ */ new Map();
  for (const [sourceId, source] of Object.entries(config.sources)) {
    for (const hook of discoverHooksFromSource(sourceId, source.path)) {
      if (map.has(hook.ref)) throw new Error(`hook\u53C2\u7167\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${hook.ref}`);
      map.set(hook.ref, hook);
    }
  }
  return map;
}
function deriveSourceId(path) {
  const skillsRoot = sourceSkillsPath(path);
  const resolved = resolve2(skillsRoot);
  const candidate = basename2(resolved) === "skills" ? basename2(dirname2(resolved)) : basename2(resolved);
  const sourceId = candidate || "source";
  validateSourceId(sourceId);
  return sourceId;
}
function addSource(path, requestedId, options) {
  const config = readConfig(options.configPath);
  const skillsRoot = sourceSkillsPath(path);
  const stat = safeLstat(skillsRoot);
  if (!stat?.isDirectory()) {
    throw new Error(`source directory\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${skillsRoot}`);
  }
  const sourceId = requestedId ?? deriveSourceId(skillsRoot);
  validateSourceId(sourceId);
  const normalizedPath = resolve2(sourceRootPath(path));
  const existing = config.sources[sourceId];
  if (existing) {
    const existingPath = resolve2(sourceRootPath(existing.path));
    if (existingPath !== normalizedPath) {
      throw new Error(
        `source id\u306F\u767B\u9332\u6E08\u307F\u3067\u3059: ${sourceId} -> ${existingPath}; \u5225\u306Eid\u3092--id\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`
      );
    }
    console.log(`source\u306F\u767B\u9332\u6E08\u307F\u3067\u3059: ${sourceId} -> ${normalizedPath}`);
    return;
  }
  config.sources[sourceId] = { path: normalizedPath };
  writeJson(options.configPath, config);
  console.log(`source\u3092\u8FFD\u52A0\u3057\u307E\u3057\u305F: ${sourceId} -> ${normalizedPath}`);
}
function printSourceList(config) {
  for (const [sourceId, source] of Object.entries(config.sources).sort(([left], [right]) => left.localeCompare(right))) {
    const root = sourceRootPath(source.path);
    const skills = discoverSkillsFromSource(sourceId, source.path).length;
    const rules = discoverRulesFromSource(sourceId, source.path).length;
    const hooks = discoverHooksFromSource(sourceId, source.path).length;
    console.log(`${sourceId}	${root}	skill ${skills}\u4EF6, rules ${rules}\u4EF6, hook ${hooks}\u4EF6`);
  }
}

// tools/skills-ctl/profile-plan.ts
import { createHash } from "node:crypto";
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function replaceHookRoot(value, root) {
  if (typeof value === "string") return value.replaceAll("{{HOOK_ROOT}}", shellQuote(root));
  if (Array.isArray(value)) return value.map((entry) => replaceHookRoot(entry, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceHookRoot(entry, root)])
    );
  }
  return value;
}
function mergedHooks(selected, packageTargets) {
  const hooks = {};
  for (const hook of selected) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync3(hook.config, "utf8"));
    } catch (error) {
      throw new Error(`hook\u8A2D\u5B9A\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093 ${hook.config}: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`hook\u8A2D\u5B9A\u306Fobject\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059: ${hook.config}`);
    }
    const record = parsed;
    const configuredHooks = record.hooks;
    const unknown = Object.keys(record).filter((key) => key !== "description" && key !== "hooks");
    if (unknown.length > 0) {
      throw new Error(`hook\u8A2D\u5B9A\u306B\u672A\u5BFE\u5FDC\u306Ekey\u304C\u3042\u308A\u307E\u3059 ${hook.config}: ${unknown.join(", ")}`);
    }
    if (!configuredHooks || typeof configuredHooks !== "object" || Array.isArray(configuredHooks)) {
      throw new Error(`hook\u8A2D\u5B9A\u306Bhooks object\u304C\u3042\u308A\u307E\u305B\u3093: ${hook.config}`);
    }
    const root = packageTargets.get(hook.ref);
    for (const [event, groups] of Object.entries(configuredHooks)) {
      if (!Array.isArray(groups)) throw new Error(`hook event\u306F\u914D\u5217\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059: ${hook.ref}:${event}`);
      const replaced = replaceHookRoot(groups, root);
      const serialized = JSON.stringify(replaced);
      if (serialized.includes("{{")) {
        throw new Error(`\u672A\u7F6E\u63DB\u306Ehook placeholder\u304C\u3042\u308A\u307E\u3059: ${hook.ref}:${event}`);
      }
      (hooks[event] ??= []).push(...JSON.parse(serialized));
    }
  }
  return `${JSON.stringify({
    description: "skillsctl\u304C\u751F\u6210\u3057\u307E\u3057\u305F\u3002\u3053\u306Efile\u3067\u306F\u306A\u304F\u6709\u52B9\u306Aprofile\u3092\u7DE8\u96C6\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    hooks
  }, null, 2)}
`;
}
function desiredPlan(profile, targetDir, codexHome, statePath, config) {
  const skills = skillMap(config);
  const entries = profile.skills.map((rawRef) => {
    const ref = normalizeSkillRef(rawRef);
    const skill = skills.get(ref);
    if (!skill) throw new Error(`skill\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${ref}`);
    return {
      kind: "skill",
      linkType: "dir",
      ref,
      sourceId: skill.sourceId,
      name: skill.name,
      source: skill.source,
      target: join3(targetDir, skill.name)
    };
  });
  if (profile.rules) {
    const rules = ruleMap(config).get(profile.rules);
    if (!rules) throw new Error(`rules\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${profile.rules}`);
    entries.push({
      kind: "rules",
      linkType: "file",
      ref: rules.ref,
      sourceId: rules.sourceId,
      name: rules.name,
      source: rules.source,
      target: join3(codexHome, "AGENTS.md")
    });
  }
  const hooks = hookMap(config);
  const selectedHooks = profile.hooks.map((ref) => {
    const hook = hooks.get(ref);
    if (!hook) throw new Error(`hook\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${ref}`);
    return hook;
  });
  const packageTargets = /* @__PURE__ */ new Map();
  for (const hook of selectedHooks) {
    const target = join3(codexHome, "managed-hooks", hook.sourceId, hook.name);
    packageTargets.set(hook.ref, target);
    entries.push({
      kind: "hook-package",
      linkType: "dir",
      ref: hook.ref,
      sourceId: hook.sourceId,
      name: hook.name,
      source: hook.source,
      target
    });
  }
  const artifacts = [];
  if (selectedHooks.length > 0) {
    const content = mergedHooks(selectedHooks, packageTargets);
    const hash = createHash("sha256").update(content).digest("hex");
    const source = join3(dirname3(statePath), "artifacts", `hooks-${hash}.json`);
    artifacts.push({ path: source, content });
    entries.push({
      kind: "hook-config",
      linkType: "file",
      ref: `generated:${hash}`,
      sourceId: "generated",
      name: hash,
      source,
      target: join3(codexHome, "hooks.json")
    });
  }
  return { entries, artifacts };
}

// tools/skills-ctl/activation.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readlinkSync,
  renameSync as renameSync2,
  symlinkSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve3 } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
function isSymlinkTo(path, source) {
  const stat = safeLstat(path);
  if (!stat?.isSymbolicLink()) return false;
  try {
    const link = readlinkSync(path);
    return resolve3(dirname4(path), link) === resolve3(source);
  } catch {
    return false;
  }
}
function managedEntryFor(state, target) {
  return state.managed.find((entry) => entry.target === target);
}
function validatePlan(desired, state, targetDir) {
  if (desired.some((entry) => entry.name === ".system")) {
    throw new Error(".system\u306F\u4FDD\u8B77\u5BFE\u8C61\u306E\u305F\u3081\u7BA1\u7406\u3067\u304D\u307E\u305B\u3093");
  }
  const targetOwners = /* @__PURE__ */ new Map();
  for (const entry of desired) {
    validateManagedTarget(entry, state, targetDir);
    const previous = targetOwners.get(entry.target);
    if (previous && previous.ref !== entry.ref) {
      throw new Error(
        `\u5C0E\u5165\u5148\u304C\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${previous.ref}\u3068${entry.ref}\u304C\u540C\u3058${entry.target}\u3092\u8981\u6C42\u3057\u3066\u3044\u307E\u3059`
      );
    }
    targetOwners.set(entry.target, entry);
  }
  if (desired.some((entry) => entry.kind === "rules")) {
    const override = join4(state.codexHome, "AGENTS.override.md");
    if (safeLstat(override)) {
      throw new Error(`AGENTS.override.md\u304C\u5E38\u6642\u30EB\u30FC\u30EB\u3092\u7121\u52B9\u306B\u3057\u307E\u3059: ${override}`);
    }
  }
  for (const entry of desired) {
    const stat = safeLstat(entry.target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      const previous = managedEntryFor(state, entry.target);
      if (!previous && !isSymlinkTo(entry.target, entry.source)) {
        throw new Error(`\u7BA1\u7406\u5916symlink\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${entry.target}`);
      }
      continue;
    }
    throw new Error(`\u65E2\u5B58\u306E\u901A\u5E38file\u307E\u305F\u306Fdirectory\u304C\u5C0E\u5165\u3092\u59A8\u3052\u3066\u3044\u307E\u3059: ${entry.target}`);
  }
  for (const entry of state.managed) {
    validateManagedTarget(entry, state, targetDir);
    const stat = safeLstat(entry.target);
    if (stat && !stat.isSymbolicLink()) {
      throw new Error(`\u7BA1\u7406\u5BFE\u8C61\u304C\u901A\u5E38file\u307E\u305F\u306Fdirectory\u3078\u7F6E\u304D\u63DB\u3048\u3089\u308C\u3066\u3044\u307E\u3059: ${entry.target}`);
    }
  }
}
function validateManagedTarget(entry, state, targetDir) {
  const target = resolve3(entry.target);
  const codexHome = resolve3(state.codexHome);
  if (entry.kind === "skill" && dirname4(target) === resolve3(targetDir)) return;
  if (entry.kind === "rules" && target === join4(codexHome, "AGENTS.md")) return;
  if (entry.kind === "hook-config" && target === join4(codexHome, "hooks.json")) return;
  const hookRoot = join4(codexHome, "managed-hooks");
  if (entry.kind === "hook-package" && target.startsWith(`${hookRoot}/`)) return;
  throw new Error(`state entry\u304C${entry.kind}\u306E\u8A31\u53EF\u7BC4\u56F2\u5916\u3067\u3059: ${entry.target}`);
}
function planLines(desired, state) {
  const lines = [
    `skill\u5C0E\u5165\u5148: ${resolve3(state.targetDir)}`,
    `Codex home: ${resolve3(state.codexHome)}`,
    `\u5C0E\u5165\u4E88\u5B9Aresource: ${desired.length}\u4EF6`
  ];
  const current = new Map(state.managed.map((entry) => [entry.target, entry]));
  const next = new Map(desired.map((entry) => [entry.target, entry]));
  for (const entry of desired) {
    const previous = current.get(entry.target);
    if (!previous) {
      lines.push(`+ link\u8FFD\u52A0 ${entry.kind} ${entry.ref} -> ${entry.source}`);
    } else if (resolve3(previous.source) !== resolve3(entry.source)) {
      lines.push(`~ link\u66F4\u65B0 ${entry.kind} ${entry.ref}: ${previous.source} -> ${entry.source}`);
    } else {
      lines.push(`= \u7DAD\u6301 ${entry.kind} ${entry.ref}`);
    }
  }
  for (const entry of state.managed) {
    if (!next.has(entry.target)) lines.push(`- link\u524A\u9664 ${entry.kind} ${entry.ref} (${entry.target})`);
  }
  if (desired.length === 0 && state.managed.length === 0) {
    lines.push("= \u7BA1\u7406\u5BFE\u8C61resource\u306A\u3057");
  }
  return lines;
}
function printPlan(desired, state) {
  for (const line of planLines(desired, state)) console.log(line);
}
function unlinkIfManaged(entry, state) {
  const stat = safeLstat(entry.target);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new Error(`\u901A\u5E38file\u307E\u305F\u306Fdirectory\u306F\u524A\u9664\u3057\u307E\u305B\u3093: ${entry.target}`);
  }
  const isKnown = Boolean(managedEntryFor(state, entry.target));
  if (!isKnown && !isSymlinkTo(entry.target, entry.source)) {
    throw new Error(`\u7BA1\u7406\u5916symlink\u306F\u524A\u9664\u3057\u307E\u305B\u3093: ${entry.target}`);
  }
  unlinkSync(entry.target);
}
function applyEntries(desired, state) {
  const desiredByTarget = new Map(desired.map((entry) => [entry.target, entry]));
  const changed = [];
  try {
    mkdirSync2(state.targetDir, { recursive: true });
    for (const previous of state.managed) {
      if (!desiredByTarget.has(previous.target)) {
        unlinkIfManaged(previous, state);
        changed.push(previous.target);
      }
    }
    for (const entry of desired) {
      mkdirSync2(dirname4(entry.target), { recursive: true });
      const stat = safeLstat(entry.target);
      if (stat?.isSymbolicLink() && isSymlinkTo(entry.target, entry.source)) continue;
      if (stat) unlinkIfManaged(entry, state);
      symlinkSync(entry.source, entry.target, entry.linkType);
      changed.push(entry.target);
    }
  } catch (error) {
    for (const target of [...changed].reverse()) {
      const stat = safeLstat(target);
      if (stat?.isSymbolicLink()) unlinkSync(target);
    }
    for (const entry of state.managed) {
      if (safeLstat(entry.target)) continue;
      mkdirSync2(dirname4(entry.target), { recursive: true });
      symlinkSync(entry.source, entry.target, entry.linkType);
    }
    throw error;
  }
}
async function applyProfile(profileName, profile, config, options) {
  const state = readState(options.statePath, options.targetDir, options.codexHome);
  state.targetDir = resolve3(options.targetDir);
  state.codexHome = resolve3(options.codexHome);
  const plan = desiredPlan(profile, state.targetDir, state.codexHome, options.statePath, config);
  const desired = plan.entries;
  validatePlan(desired, state, state.targetDir);
  printPlan(desired, state);
  if (options.dryRun) return;
  if (!options.yes) {
    const rl = createInterface({ input, output });
    const confirmation = await rl.question("\u3053\u306Eplan\u3092\u9069\u7528\u3057\u307E\u3059\u304B\uFF1F [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(confirmation.trim())) {
      console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
      return;
    }
  }
  const backup = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    activeProfile: state.activeProfile,
    managed: state.managed
  };
  for (const artifact of plan.artifacts) {
    if (!existsSync3(artifact.path)) writeJsonArtifact(artifact);
  }
  applyEntries(desired, state);
  const nextState = {
    version: 3,
    codexHome: state.codexHome,
    targetDir: state.targetDir,
    activeProfile: profileName,
    managed: desired,
    history: [...state.history, backup].slice(-20)
  };
  try {
    writeJsonAtomic(options.statePath, nextState);
  } catch (error) {
    applyEntries(state.managed, { ...state, managed: desired });
    throw error;
  }
  console.log(`profile\u3092\u9069\u7528\u3057\u307E\u3057\u305F: ${profileName}`);
  if (profile.rules) console.log("\u5E38\u6642\u30EB\u30FC\u30EB\u306F\u6B21\u306ECodex run\u304B\u3089\u6709\u52B9\u3067\u3059");
}
function writeJsonArtifact(artifact) {
  mkdirSync2(dirname4(artifact.path), { recursive: true });
  const temporary = `${artifact.path}.${process.pid}.tmp`;
  writeFileSync2(temporary, artifact.content, { mode: 384 });
  renameSync2(temporary, artifact.path);
}
function inspectStatus(state) {
  console.log(`\u5C0E\u5165\u5148: ${resolve3(state.targetDir)}`);
  console.log(`\u6709\u52B9\u306Aprofile: ${state.activeProfile ?? "(\u306A\u3057)"}`);
  if (state.managed.length === 0) {
    console.log("\u7BA1\u7406\u5BFE\u8C61resource: \u306A\u3057");
    return;
  }
  for (const entry of state.managed) {
    const status = !existsSync3(entry.source) ? "source-missing" : isSymlinkTo(entry.target, entry.source) ? "ok" : safeLstat(entry.target) ? "drifted" : "missing";
    console.log(`${status}	${entry.kind}	${entry.ref}	${entry.target} -> ${entry.source}`);
  }
}
async function rollback(options) {
  const state = readState(options.statePath, options.targetDir, options.codexHome);
  const backup = state.history.at(-1);
  if (!backup) throw new Error("rollback\u5C65\u6B74\u304C\u3042\u308A\u307E\u305B\u3093");
  const desired = backup.managed;
  validatePlan(desired, state, state.targetDir);
  console.log(`rollback\u5148: ${backup.activeProfile ?? "(\u306A\u3057)"}`);
  printPlan(desired, state);
  if (!options.yes) {
    const rl = createInterface({ input, output });
    const confirmation = await rl.question("rollback\u3092\u5B9F\u884C\u3057\u307E\u3059\u304B\uFF1F [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(confirmation.trim())) {
      console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
      return;
    }
  }
  const currentBackup = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    activeProfile: state.activeProfile,
    managed: state.managed
  };
  applyEntries(desired, state);
  const restoredState = {
    version: 3,
    codexHome: state.codexHome,
    targetDir: state.targetDir,
    activeProfile: backup.activeProfile,
    managed: desired,
    history: [...state.history.slice(0, -1), currentBackup].slice(-20)
  };
  try {
    writeJsonAtomic(options.statePath, restoredState);
  } catch (error) {
    applyEntries(state.managed, { ...state, managed: desired });
    throw error;
  }
  console.log("rollback\u304C\u5B8C\u4E86\u3057\u307E\u3057\u305F");
}

// tools/skills-ctl/tui.ts
import {
  autocomplete,
  autocompleteMultiselect,
  confirm,
  isCancel,
  text
} from "@clack/prompts";
var defaultPromptFunctions = {
  autocomplete: (options) => autocomplete(options),
  autocompleteMultiselect: (options) => autocompleteMultiselect(options),
  confirm: (options) => confirm(options),
  text: (options) => text(options),
  isCancel
};
function pickerOptions(items) {
  const duplicateNames = /* @__PURE__ */ new Map();
  for (const item of items) {
    const name = item.ref.slice(item.ref.indexOf(":") + 1);
    duplicateNames.set(name, (duplicateNames.get(name) ?? 0) + 1);
  }
  return items.map((item) => {
    const name = item.ref.slice(item.ref.indexOf(":") + 1);
    const location = duplicateNames.get(name) > 1 ? item.source : "";
    return {
      value: item.ref,
      label: item.ref,
      hint: descriptionHint(item.description, item.ref),
      searchText: [item.ref, item.description, location].filter(Boolean).join("\n")
    };
  });
}
function displayWidth(value) {
  let width = 0;
  for (const character of value) width += character.codePointAt(0) <= 127 ? 1 : 2;
  return width;
}
function truncateToWidth(value, maxWidth) {
  if (displayWidth(value) <= maxWidth) return value;
  const contentWidth = Math.max(0, maxWidth - 3);
  let result = "";
  let width = 0;
  for (const character of value) {
    const characterWidth = character.codePointAt(0) <= 127 ? 1 : 2;
    if (width + characterWidth > contentWidth) break;
    result += character;
    width += characterWidth;
  }
  return `${result}...`;
}
function descriptionHint(description, label) {
  const normalized = description.replaceAll(/\s+/g, " ").trim();
  const availableWidth = Math.min(48, (process.stdout.columns ?? 80) - displayWidth(label) - 10);
  return normalized && availableWidth >= 8 ? truncateToWidth(normalized, availableWidth) : void 0;
}
function dynamicMultiPickerOptions(items, existingValues) {
  const options = pickerOptions(items);
  const itemByRef = new Map(items.map((item) => [item.ref, item]));
  const existing = new Set(existingValues);
  return function() {
    const selected = new Set(this.selectedValues);
    for (const option of options) {
      const item = itemByRef.get(option.value);
      const isNew = selected.has(option.value) && !existing.has(option.value);
      option.label = `${option.value}${isNew ? " [\u65B0\u898F]" : ""}`;
      option.hint = descriptionHint(item.description, option.label);
    }
    return options;
  };
}
function filterPickerOption(search, option) {
  const query = search.toLowerCase();
  return [option.label, option.value, option.hint, option.searchText].some((value) => value?.toLowerCase().includes(query));
}
async function runMultiPicker(items, message, initialValues = [], prompts = defaultPromptFunctions) {
  if (items.length === 0) return [];
  const available = new Set(items.map((item) => item.ref));
  const existingValues = initialValues.filter((value) => available.has(value));
  const promptInitialValues = existingValues.length <= 1 ? existingValues : [...existingValues.slice(1), existingValues[0]];
  const result = await prompts.autocompleteMultiselect({
    message,
    options: dynamicMultiPickerOptions(items, existingValues),
    initialValues: promptInitialValues,
    maxItems: 8,
    placeholder: "\u5165\u529B\u3057\u3066\u7D5E\u308A\u8FBC\u307F",
    required: false,
    filter: filterPickerOption
  });
  if (prompts.isCancel(result)) return null;
  const selectedValues = result;
  const selected = new Set(selectedValues);
  const existing = new Set(existingValues);
  return [
    ...existingValues.filter((value) => selected.has(value)),
    ...selectedValues.filter((value) => !existing.has(value))
  ];
}
async function runSinglePicker(items, message, initialValue = null, prompts = defaultPromptFunctions) {
  if (items.length === 0) return null;
  const result = await prompts.autocomplete({
    message,
    options: [
      { value: "", label: "(\u306A\u3057)", hint: "\u9078\u629E\u3092\u89E3\u9664" },
      ...pickerOptions(items)
    ],
    initialValue: initialValue ?? "",
    maxItems: 8,
    placeholder: "\u5165\u529B\u3057\u3066\u7D5E\u308A\u8FBC\u307F",
    filter: filterPickerOption
  });
  if (prompts.isCancel(result)) return void 0;
  return result === "" ? null : result;
}
var createProfileValue = "\0create-profile";
async function runProfilePicker(config, prompts = defaultPromptFunctions) {
  const result = await prompts.autocomplete({
    message: "\u7DE8\u96C6\u3059\u308Bprofile",
    options: [
      ...Object.keys(config.profiles).sort().map((name) => ({
        value: name,
        label: name,
        hint: `${config.profiles[name].skills.length} skills`
      })),
      { value: createProfileValue, label: "+ profile\u3092\u4F5C\u6210", hint: "\u65B0\u3057\u3044profile" }
    ],
    placeholder: "\u5165\u529B\u3057\u3066\u7D5E\u308A\u8FBC\u307F"
  });
  if (prompts.isCancel(result)) return null;
  return result === createProfileValue ? "+ profile\u3092\u4F5C\u6210" : result;
}
function validateProfileName(name) {
  if (!name.trim() || name === "." || name === ".." || /[\\/\0-\x1f]/.test(name)) {
    throw new Error(`profile\u540D\u304C\u4E0D\u6B63\u3067\u3059: ${name}`);
  }
}
async function createProfileFromPicker(config, prompts = defaultPromptFunctions) {
  const result = await prompts.text({
    message: "\u65B0\u3057\u3044profile\u540D",
    validate: (value) => {
      try {
        validateProfileName(value.trim());
        if (config.profiles[value.trim()]) return "profile\u306F\u4F5C\u6210\u6E08\u307F\u3067\u3059";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  if (prompts.isCancel(result)) return null;
  const name = result.trim();
  if (!name) {
    console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
    return null;
  }
  return name;
}
async function profilePickerTui(options, prompts = defaultPromptFunctions) {
  const config = readConfig(options.configPath);
  const selected = await runProfilePicker(config, prompts);
  if (!selected) {
    console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
    return;
  }
  const profileName = selected === "+ profile\u3092\u4F5C\u6210" ? await createProfileFromPicker(config, prompts) : selected;
  if (!profileName) return;
  await profileTui(profileName, options, prompts);
}
async function profileTui(profileName, options, prompts = defaultPromptFunctions) {
  validateProfileName(profileName);
  const config = readConfig(options.configPath);
  const currentProfile = config.profiles[profileName];
  const skills = discoverSkills(config);
  if (skills.length === 0) throw new Error("skill\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const selectedSkills = await runMultiPicker(skills.map((skill) => ({
    ref: skill.ref,
    description: skill.description,
    source: skill.source
  })), "profile\u306B\u542B\u3081\u308Bskill", currentProfile?.skills ?? [], prompts);
  if (selectedSkills === null) {
    console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
    return;
  }
  const rules = [...ruleMap(config).values()];
  const selectedRules = await runSinglePicker(rules.map((rule) => ({
    ref: rule.ref,
    description: "\u5E38\u6642\u8AAD\u307F\u8FBC\u3080AGENTS.md",
    source: rule.source
  })), "profile\u3067\u4F7F\u3046\u5E38\u6642\u30EB\u30FC\u30EB", currentProfile?.rules ?? null, prompts);
  if (selectedRules === void 0) {
    console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
    return;
  }
  const hooks = [...hookMap(config).values()];
  const selectedHooks = await runMultiPicker(hooks.map((hook) => ({
    ref: hook.ref,
    description: "Codex hook package",
    source: hook.source
  })), "profile\u306B\u542B\u3081\u308Bhook", currentProfile?.hooks ?? [], prompts);
  if (selectedHooks === null) {
    console.log("\u4E2D\u6B62\u3057\u307E\u3057\u305F");
    return;
  }
  config.profiles[profileName] = {
    description: config.profiles[profileName]?.description ?? "skillsctl\u3067\u4F5C\u6210",
    skills: selectedSkills,
    rules: selectedRules,
    hooks: selectedHooks
  };
  writeJson(options.configPath, config);
  console.log(`profile\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F: ${profileName}`);
  const shouldApply = await prompts.confirm({
    message: "\u4FDD\u5B58\u3057\u305Fprofile\u3092\u4ECA\u3059\u3050\u9069\u7528\u3057\u307E\u3059\u304B\uFF1F",
    active: "\u9069\u7528\u3059\u308B",
    inactive: "\u4FDD\u5B58\u306E\u307F",
    initialValue: false
  });
  if (prompts.isCancel(shouldApply) || shouldApply !== true) {
    console.log(`\u5F8C\u3067\u9069\u7528: skillsctl apply ${profileName}`);
    return;
  }
  await applyProfile(
    profileName,
    getProfile(config, profileName),
    config,
    { ...options, yes: true }
  );
}
function printSkillList(config, verbose) {
  const skills = discoverSkills(config);
  if (!verbose) {
    const bySource = /* @__PURE__ */ new Map();
    for (const skill of skills) {
      const sourceSkills = bySource.get(skill.sourceId) ?? [];
      sourceSkills.push(skill);
      bySource.set(skill.sourceId, sourceSkills);
    }
    for (const [sourceId, sourceSkills] of bySource) {
      console.log(`${sourceId} (${sourceSkills.length})`);
      for (const skill of sourceSkills) console.log(`  ${skill.name}`);
    }
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.ref}	${skill.source}	${skill.description}`);
  }
}
function printProfileList(config) {
  const names = Object.keys(config.profiles).sort();
  if (names.length === 0) {
    console.log("profile\u306F\u3042\u308A\u307E\u305B\u3093");
    return;
  }
  for (const name of names) {
    const profile = getProfile(config, name);
    console.log(`${name}	skill ${profile.skills.length}\u4EF6, rules ${profile.rules ? "1" : "0"}\u4EF6, hook ${profile.hooks.length}\u4EF6`);
  }
}
function printProfile(config, name) {
  const profile = getProfile(config, name);
  console.log(JSON.stringify({ name, ...profile }, null, 2));
}

// tools/skills-ctl.ts
function usage() {
  console.log(`personal-skills profile\u7BA1\u7406

\u4F7F\u3044\u65B9:
  skillsctl                         profile\u3092\u9078\u629E\u30FB\u4F5C\u6210\u3057\u3066resource\u3092\u7DE8\u96C6
  skillsctl tui [name]              \u6307\u5B9Aprofile\u3092\u7DE8\u96C6
  npm run skillsctl -- skills
  npm run skillsctl -- sources list
  npm run skillsctl -- sources add <path> [--id <id>]
  npm run skillsctl -- profile list
  npm run skillsctl -- profile show <name>
  npm run skillsctl -- profile tui [name]
  npm run skillsctl -- plan <name>
  npm run skillsctl -- apply <name> [--dry-run] [--yes]
  npm run skillsctl -- status
  npm run skillsctl -- rollback [--yes]

`);
  console.log("  --verbose, -v        skill\u306Epath\u3068\u8AAC\u660E\u3092\u8868\u793A");
}
async function main() {
  const firstArg = process.argv[2];
  const hasCommand = Boolean(
    firstArg && (!firstArg.startsWith("-") || firstArg === "--help" || firstArg === "-h")
  );
  const command = hasCommand ? process.argv[2] : "tui";
  const { positionals, options } = parseOptions(
    hasCommand ? process.argv.slice(3) : process.argv.slice(2)
  );
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    case "tui":
      if (positionals[0]) await profileTui(positionals[0], options);
      else await profilePickerTui(options);
      return;
    case "skills": {
      printSkillList(readConfig(options.configPath), options.verbose);
      return;
    }
    case "sources": {
      const subcommand = positionals[0] ?? "list";
      if (subcommand === "list") {
        printSourceList(readConfig(options.configPath));
        return;
      }
      if (subcommand === "add") {
        const path = positionals[1];
        if (!path) throw new Error("sources add\u306B\u306Fdirectory path\u304C\u5FC5\u8981\u3067\u3059");
        addSource(path, options.sourceId, options);
        return;
      }
      throw new Error(`\u4E0D\u660E\u306Asources command\u3067\u3059: ${subcommand}`);
    }
    case "status":
      inspectStatus(readState(options.statePath, options.targetDir, options.codexHome));
      return;
    case "rollback":
      await rollback(options);
      return;
    case "plan":
    case "apply": {
      const name = positionals[0];
      if (!name) throw new Error(`${command}\u306B\u306Fprofile\u540D\u304C\u5FC5\u8981\u3067\u3059`);
      const config = readConfig(options.configPath);
      const profile = getProfile(config, name);
      if (command === "plan") {
        const state = readState(options.statePath, options.targetDir, options.codexHome);
        state.targetDir = resolve4(options.targetDir);
        state.codexHome = resolve4(options.codexHome);
        const plan = desiredPlan(profile, state.targetDir, state.codexHome, options.statePath, config);
        validatePlan(plan.entries, state, state.targetDir);
        printPlan(plan.entries, state);
        return;
      }
      await applyProfile(name, profile, config, options);
      return;
    }
    case "profile": {
      const subcommand = positionals[0] ?? "list";
      const config = readConfig(options.configPath);
      if (subcommand === "list") {
        printProfileList(config);
        return;
      }
      if (subcommand === "show") {
        const name = positionals[1];
        if (!name) throw new Error("profile show\u306B\u306Fprofile\u540D\u304C\u5FC5\u8981\u3067\u3059");
        printProfile(config, name);
        return;
      }
      if (subcommand === "tui") {
        if (positionals[1]) await profileTui(positionals[1], options);
        else await profilePickerTui(options);
        return;
      }
      throw new Error(`\u4E0D\u660E\u306Aprofile command\u3067\u3059: ${subcommand}`);
    }
    default:
      throw new Error(`\u4E0D\u660E\u306Acommand\u3067\u3059: ${command}`);
  }
}
main().catch((error) => {
  console.error(`\u30A8\u30E9\u30FC: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
