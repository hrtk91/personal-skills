import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type Backup,
  type Config,
  type HarnessTarget,
  type ManagedEntry,
  type Options,
  type Profile,
  type State,
  readState,
  safeLstat,
  writeJsonAtomic,
} from "./model.ts";
import { type GeneratedArtifact, desiredPlan } from "./profile-plan.ts";

type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, unknown[]>;
};

interface SettingsSnapshot {
  path: string;
  existed: boolean;
  content: string;
  mode: number;
}

export function isSymlinkTo(path: string, source: string): boolean {
  const stat = safeLstat(path);
  if (!stat?.isSymbolicLink()) return false;
  try {
    const link = readlinkSync(path);
    return resolve(dirname(path), link) === resolve(source);
  } catch {
    return false;
  }
}

export function managedEntryFor(state: State, target: string): ManagedEntry | undefined {
  return state.managed.find((entry) => resolve(entry.target) === resolve(target));
}

function isClaudeHookConfig(entry: ManagedEntry): boolean {
  return entry.harness === "claude" && entry.kind === "claude-hook-config";
}

function linkEntries(entries: ManagedEntry[]): ManagedEntry[] {
  return entries.filter((entry) => !isClaudeHookConfig(entry));
}

function claudeHookEntry(entries: ManagedEntry[]): ManagedEntry | undefined {
  return entries.find(isClaudeHookConfig);
}

export function detachLegacyRulesEntries(state: State): State {
  const legacyTarget = join(resolve(state.codexHome), "AGENTS.md");
  const isLegacyRulesEntry = (entry: ManagedEntry): boolean =>
    entry.harness === "codex" && entry.kind === "rules" && resolve(entry.target) === legacyTarget;
  const hasLegacyEntry = state.managed.some(isLegacyRulesEntry)
    || state.history.some((backup) => backup.managed.some(isLegacyRulesEntry));
  if (!hasLegacyEntry) return state;

  const stat = safeLstat(legacyTarget);
  if (stat?.isSymbolicLink()) {
    throw new Error(`旧rules管理対象のAGENTS.mdを実ファイルへ移行してから適用してください: ${legacyTarget}`);
  }
  if (stat && !stat.isFile()) {
    throw new Error(`AGENTS.mdは通常fileである必要があります: ${legacyTarget}`);
  }

  const withoutLegacy = (entries: ManagedEntry[]): ManagedEntry[] =>
    entries.filter((entry) => !isLegacyRulesEntry(entry));
  return {
    ...state,
    managed: withoutLegacy(state.managed),
    history: state.history.map((backup) => ({
      ...backup,
      managed: withoutLegacy(backup.managed),
    })),
  };
}

export function validatePlan(
  desired: ManagedEntry[],
  state: State,
  targetDir: string,
  artifacts: GeneratedArtifact[] = [],
): void {
  if (desired.some((entry) => entry.kind === "skill" && entry.name === ".system")) {
    throw new Error(".systemは保護対象のため管理できません");
  }

  const targetOwners = new Map<string, ManagedEntry>();
  for (const entry of desired) {
    validateManagedTarget(entry, state, targetDir);
    const target = resolve(entry.target);
    const previous = targetOwners.get(target);
    if (previous && (previous.ref !== entry.ref || previous.harness !== entry.harness)) {
      throw new Error(
        `導入先が衝突しています: ${previous.ref}と${entry.ref}が同じ${entry.target}を要求しています`,
      );
    }
    targetOwners.set(target, entry);
  }

  for (const entry of desired) {
    if (isClaudeHookConfig(entry)) {
      readClaudeSettings(entry.target);
      continue;
    }
    const stat = safeLstat(entry.target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      const previous = managedEntryFor(state, entry.target);
      if (!previous && !isSymlinkTo(entry.target, entry.source)) {
        throw new Error(`管理外symlinkと衝突しています: ${entry.target}`);
      }
      continue;
    }
    throw new Error(`既存の通常fileまたはdirectoryが導入を妨げています: ${entry.target}`);
  }

  for (const entry of state.managed) {
    validateManagedTarget(entry, state, targetDir);
    if (isClaudeHookConfig(entry)) {
      assertClaudeHooksPresent(entry);
      continue;
    }
    const stat = safeLstat(entry.target);
    if (stat && !stat.isSymbolicLink()) {
      throw new Error(`管理対象が通常fileまたはdirectoryへ置き換えられています: ${entry.target}`);
    }
  }

  const artifactContent = new Map(artifacts.map((artifact) => [resolve(artifact.path), artifact.content]));
  const previousClaudeHooks = claudeHookEntry(state.managed);
  for (const entry of desired) {
    if (!isClaudeHookConfig(entry)) continue;
    const settings = readClaudeSettings(entry.target);
    const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };
    if (previousClaudeHooks) {
      const previousGroups = readHookArtifact(previousClaudeHooks);
      for (const [event, groups] of Object.entries(previousGroups)) {
        const current = hooks[event];
        if (!Array.isArray(current)) {
          throw new Error(`管理対象Claude hookが見つかりません: ${event} (${entry.target})`);
        }
        const remaining = [...current];
        for (const group of groups) {
          const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
          if (index === -1) {
            throw new Error(`管理対象Claude hookが変更または削除されています: ${event} (${entry.target})`);
          }
          remaining.splice(index, 1);
        }
        if (remaining.length === 0) delete hooks[event];
        else hooks[event] = remaining;
      }
    }

    const desiredGroups = readHookArtifact(
      entry,
      artifactContent.get(resolve(entry.source)),
    );
    for (const [event, groups] of Object.entries(desiredGroups)) {
      const current = hooks[event] ?? [];
      if (!Array.isArray(current)) throw new Error(`Claude hook eventは配列である必要があります: ${event}`);
      if (groups.some((group) => current.some((candidate) => isDeepStrictEqual(candidate, group)))) {
        throw new Error(`既存hookと同じClaude hook groupを安全に区別できません: ${event} (${entry.target})`);
      }
    }
  }
}

export function validateManagedTarget(entry: ManagedEntry, state: State, targetDir: string): void {
  const target = resolve(entry.target);
  const codexHome = resolve(state.codexHome);
  const claudeHome = resolve(state.claudeHome);
  if (entry.kind === "skill" && entry.harness === "codex" && dirname(target) === resolve(targetDir)) return;
  if (entry.kind === "skill" && entry.harness === "claude" && dirname(target) === join(claudeHome, "skills")) return;
  if (entry.kind === "rules" && entry.harness === "codex" && target === join(codexHome, "AGENTS.override.md")) return;
  if (entry.kind === "rules" && entry.harness === "claude" && target === join(claudeHome, "rules", "harnessctl-personal-skills.md")) return;
  if (entry.kind === "hook-config" && entry.harness === "codex" && target === join(codexHome, "hooks.json")) return;
  if (entry.kind === "claude-hook-config" && entry.harness === "claude" && target === join(claudeHome, "settings.json")) return;
  const hookRoot = join(entry.harness === "codex" ? codexHome : claudeHome, "managed-hooks");
  if (entry.kind === "hook-package" && target.startsWith(`${hookRoot}/`)) return;
  throw new Error(`state entryが${entry.kind}の許可範囲外です: ${entry.target}`);
}

function planAction(entry: ManagedEntry): string {
  return isClaudeHookConfig(entry) ? "hook" : "link";
}

export function planLines(
  desired: ManagedEntry[],
  state: State,
  selectedTargets: HarnessTarget[] = [...new Set(desired.map((entry) => entry.harness))],
): string[] {
  const lines = [
    `対象ハーネス: ${selectedTargets.length ? selectedTargets.join(", ") : "(なし)"}`,
    `skill導入先 (Codex): ${resolve(state.targetDir)}`,
    `Codex home: ${resolve(state.codexHome)}`,
    `Claude home: ${resolve(state.claudeHome)}`,
    `導入予定resource: ${desired.length}件`,
  ];
  const current = new Map(state.managed.map((entry) => [resolve(entry.target), entry]));
  const next = new Map(desired.map((entry) => [resolve(entry.target), entry]));

  for (const entry of desired) {
    const previous = current.get(resolve(entry.target));
    const action = planAction(entry);
    if (!previous) {
      lines.push(`+ ${action}追加 ${entry.kind} ${entry.ref} [${entry.harness}] -> ${entry.source}`);
    } else if (resolve(previous.source) !== resolve(entry.source)) {
      lines.push(`~ ${action}更新 ${entry.kind} ${entry.ref} [${entry.harness}]: ${previous.source} -> ${entry.source}`);
    } else {
      lines.push(`= 維持 ${entry.kind} ${entry.ref} [${entry.harness}]`);
    }
  }

  for (const entry of state.managed) {
    if (!next.has(resolve(entry.target))) {
      lines.push(`- ${planAction(entry)}削除 ${entry.kind} ${entry.ref} [${entry.harness}] (${entry.target})`);
    }
  }

  if (desired.length === 0 && state.managed.length === 0) {
    lines.push("= 管理対象resourceなし");
  }
  return lines;
}

export function printPlan(
  desired: ManagedEntry[],
  state: State,
  notices: string[] = [],
  selectedTargets: HarnessTarget[] = [...new Set(desired.map((entry) => entry.harness))],
): void {
  for (const line of planLines(desired, state, selectedTargets)) console.log(line);
  for (const notice of notices) console.log(`! ${notice}`);
}

export function unlinkIfManaged(entry: ManagedEntry, state: State): void {
  if (isClaudeHookConfig(entry)) return;
  const stat = safeLstat(entry.target);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new Error(`通常fileまたはdirectoryは削除しません: ${entry.target}`);
  }
  const isKnown = Boolean(managedEntryFor(state, entry.target));
  if (!isKnown && !isSymlinkTo(entry.target, entry.source)) {
    throw new Error(`管理外symlinkは削除しません: ${entry.target}`);
  }
  unlinkSync(entry.target);
}

export function applyEntries(
  desired: ManagedEntry[],
  state: State,
): void {
  const desiredLinks = linkEntries(desired);
  const currentLinks = linkEntries(state.managed);
  const desiredByTarget = new Map(desiredLinks.map((entry) => [resolve(entry.target), entry]));
  const changed: string[] = [];

  try {
    for (const previous of currentLinks) {
      if (!desiredByTarget.has(resolve(previous.target))) {
        unlinkIfManaged(previous, state);
        changed.push(previous.target);
      }
    }

    for (const entry of desiredLinks) {
      mkdirSync(dirname(entry.target), { recursive: true });
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
    for (const entry of currentLinks) {
      if (safeLstat(entry.target)) continue;
      mkdirSync(dirname(entry.target), { recursive: true });
      symlinkSync(entry.source, entry.target, entry.linkType);
    }
    throw error;
  }
}

function readHookArtifact(entry: ManagedEntry, artifactContent?: string): Record<string, unknown[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifactContent ?? readFileSync(entry.source, "utf8"));
  } catch (error) {
    throw new Error(`Claude hook artifactを読み込めません ${entry.source}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Claude hook artifactはobjectである必要があります: ${entry.source}`);
  }
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`Claude hook artifactにhooks objectがありません: ${entry.source}`);
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Claude hook eventは配列である必要があります: ${event}`);
  }
  return hooks as Record<string, unknown[]>;
}

function readClaudeSettings(path: string): ClaudeSettings {
  const stat = safeLstat(path);
  if (stat?.isSymbolicLink()) throw new Error(`settings.jsonがsymlinkのため変更できません: ${path}`);
  if (stat && !stat.isFile()) throw new Error(`settings.jsonは通常fileである必要があります: ${path}`);
  if (!stat) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Claude settings.jsonを読み込めません ${path}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Claude settings.jsonはobjectである必要があります: ${path}`);
  }
  const settings = parsed as ClaudeSettings;
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    throw new Error(`Claude settings.jsonのhooksはobjectである必要があります: ${path}`);
  }
  return settings;
}

function assertClaudeHooksPresent(entry: ManagedEntry): void {
  const expected = readHookArtifact(entry);
  const actual = readClaudeSettings(entry.target).hooks ?? {};
  for (const [event, groups] of Object.entries(expected)) {
    const current = actual[event];
    if (!Array.isArray(current)) throw new Error(`管理対象Claude hookが見つかりません: ${event} (${entry.target})`);
    const distinctGroups: unknown[] = [];
    for (const group of groups) {
      if (!distinctGroups.some((candidate) => isDeepStrictEqual(candidate, group))) {
        distinctGroups.push(group);
      }
    }
    for (const group of distinctGroups) {
      const expectedCount = groups.filter((candidate) => isDeepStrictEqual(candidate, group)).length;
      const actualCount = current.filter((candidate) => isDeepStrictEqual(candidate, group)).length;
      if (actualCount !== expectedCount) {
        throw new Error(`管理対象Claude hookが変更・削除・重複しています: ${event} (${entry.target})`);
      }
    }
  }
}

function snapshotSettings(path: string): SettingsSnapshot {
  const stat = safeLstat(path);
  if (stat?.isSymbolicLink()) throw new Error(`settings.jsonがsymlinkのため変更できません: ${path}`);
  if (stat && !stat.isFile()) throw new Error(`settings.jsonは通常fileである必要があります: ${path}`);
  return {
    path,
    existed: Boolean(stat),
    content: stat ? readFileSync(path, "utf8") : "",
    mode: stat ? stat.mode & 0o777 : 0o600,
  };
}

function restoreSettingsSnapshot(snapshot: SettingsSnapshot): void {
  const current = safeLstat(snapshot.path);
  if (current?.isSymbolicLink() || (current && !current.isFile())) {
    throw new Error(`settings.jsonが通常fileではなくなったため復元できません: ${snapshot.path}`);
  }
  if (!snapshot.existed) {
    if (current) unlinkSync(snapshot.path);
    return;
  }
  writeSettingsFile(snapshot.path, snapshot.content, snapshot.mode);
}

function writeSettingsFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

function updateClaudeSettingsHooks(previous?: ManagedEntry, desired?: ManagedEntry): void {
  if (!previous && !desired) return;
  const path = (desired ?? previous)!.target;
  const settings = readClaudeSettings(path);
  const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };

  if (previous) {
    const managedHooks = readHookArtifact(previous);
    for (const [event, groups] of Object.entries(managedHooks)) {
      const current = hooks[event];
      if (!Array.isArray(current)) {
        throw new Error(`管理対象Claude hookが見つかりません: ${event} (${path})`);
      }
      const remaining = [...current];
      for (const group of groups) {
        const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
        if (index === -1) {
          throw new Error(`管理対象Claude hookが変更または削除されています: ${event} (${path})`);
        }
        remaining.splice(index, 1);
      }
      if (remaining.length === 0) delete hooks[event];
      else hooks[event] = remaining;
    }
  }

  if (desired) {
    const managedHooks = readHookArtifact(desired);
    for (const [event, groups] of Object.entries(managedHooks)) {
      const current = hooks[event] ?? [];
      if (!Array.isArray(current)) throw new Error(`Claude hook eventは配列である必要があります: ${event}`);
      for (const group of groups) {
        if (current.some((candidate) => isDeepStrictEqual(candidate, group))) {
          throw new Error(`既存hookと同じClaude hook groupを安全に区別できません: ${event} (${path})`);
        }
      }
      hooks[event] = [...current, ...groups];
    }
  }

  const nextSettings: ClaudeSettings = { ...settings };
  if (Object.keys(hooks).length === 0) delete nextSettings.hooks;
  else nextSettings.hooks = hooks;
  const snapshot = snapshotSettings(path);
  writeSettingsFile(path, `${JSON.stringify(nextSettings, null, 2)}\n`, snapshot.mode);
}

function applyManagedResources(desired: ManagedEntry[], state: State): SettingsSnapshot | null {
  const previousHooks = claudeHookEntry(state.managed);
  const desiredHooks = claudeHookEntry(desired);
  const settingsPath = desiredHooks?.target ?? previousHooks?.target;
  const settingsSnapshot = settingsPath ? snapshotSettings(settingsPath) : null;
  const currentLinks = linkEntries(state.managed);
  const desiredLinks = linkEntries(desired);
  try {
    applyEntries(desiredLinks, { ...state, managed: currentLinks });
    updateClaudeSettingsHooks(previousHooks, desiredHooks);
  } catch (error) {
    const restorationErrors: string[] = [];
    try {
      applyEntries(currentLinks, { ...state, managed: desiredLinks });
    } catch (rollbackError) {
      restorationErrors.push(`symlink復元: ${String(rollbackError)}`);
    }
    if (settingsSnapshot) {
      try {
        restoreSettingsSnapshot(settingsSnapshot);
      } catch (rollbackError) {
        restorationErrors.push(`settings復元: ${String(rollbackError)}`);
      }
    }
    if (restorationErrors.length > 0) {
      throw new Error(`${String(error)} (${restorationErrors.join("; ")})`);
    }
    throw error;
  }
  return settingsSnapshot;
}

function restoreAfterStateFailure(
  desired: ManagedEntry[],
  state: State,
  settingsSnapshot: SettingsSnapshot | null,
): void {
  const errors: string[] = [];
  try {
    applyEntries(linkEntries(state.managed), { ...state, managed: linkEntries(desired) });
  } catch (error) {
    errors.push(`symlink復元: ${String(error)}`);
  }
  if (settingsSnapshot) {
    try {
      restoreSettingsSnapshot(settingsSnapshot);
    } catch (error) {
      errors.push(`settings復元: ${String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

export async function applyProfile(
  profileName: string,
  profile: Profile,
  config: Config,
  options: Options,
): Promise<void> {
  let state = readState(options.statePath, options.targetDir, options.codexHome, options.claudeHome);
  state.targetDir = resolve(options.targetDir);
  state.codexHome = resolve(options.codexHome);
  state.claudeHome = resolve(options.claudeHome);
  state = detachLegacyRulesEntries(state);
  const plan = desiredPlan(
    profile,
    state.targetDir,
    state.codexHome,
    state.claudeHome,
    options.statePath,
    config,
  );
  const desired = plan.entries;
  validatePlan(desired, state, state.targetDir, plan.artifacts);
  printPlan(desired, state, plan.notices, profile.targets);

  if (options.dryRun) return;

  if (!options.yes) {
    const rl = createInterface({ input, output });
    const confirmation = await rl.question("このplanを適用しますか？ [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(confirmation.trim())) {
      console.log("中止しました");
      return;
    }
  }

  const backup: Backup = {
    timestamp: new Date().toISOString(),
    activeProfile: state.activeProfile,
    targets: state.targets,
    managed: state.managed,
  };
  for (const artifact of plan.artifacts) {
    if (!existsSync(artifact.path)) writeArtifact(artifact);
  }
  const settingsSnapshot = applyManagedResources(desired, state);
  const nextState: State = {
    version: 4,
    codexHome: state.codexHome,
    claudeHome: state.claudeHome,
    targetDir: state.targetDir,
    activeProfile: profileName,
    targets: profile.targets,
    managed: desired,
    history: [...state.history, backup].slice(-20),
  };
  try {
    writeJsonAtomic(options.statePath, nextState);
  } catch (error) {
    try {
      restoreAfterStateFailure(desired, state, settingsSnapshot);
    } catch (rollbackError) {
      throw new Error(`${String(error)} (resource復元に失敗しました: ${String(rollbackError)})`);
    }
    throw error;
  }
  console.log(`profileを適用しました: ${profileName}`);
  if (profile.rules.length > 0) {
    const targets = profile.targets.join("・") || "選択したハーネス";
    console.log(`常時ルールは次の${targets} runから有効です`);
  }
}

export function writeArtifact(artifact: GeneratedArtifact): void {
  mkdirSync(dirname(artifact.path), { recursive: true });
  const temporary = `${artifact.path}.${process.pid}.tmp`;
  writeFileSync(temporary, artifact.content, { mode: 0o600 });
  renameSync(temporary, artifact.path);
}

function claudeHookStatus(entry: ManagedEntry): "ok" | "drifted" | "missing" {
  if (!existsSync(entry.source) || !existsSync(entry.target)) return "missing";
  try {
    assertClaudeHooksPresent(entry);
    return "ok";
  } catch {
    return "drifted";
  }
}

export function inspectStatus(state: State): void {
  console.log(`skill導入先 (Codex): ${resolve(state.targetDir)}`);
  console.log(`Codex home: ${resolve(state.codexHome)}`);
  console.log(`Claude home: ${resolve(state.claudeHome)}`);
  console.log(`有効なprofile: ${state.activeProfile ?? "(なし)"}`);
  console.log(`対象ハーネス: ${state.targets.join(", ") || "(なし)"}`);
  if (state.managed.length === 0) {
    console.log("管理対象resource: なし");
    return;
  }
  for (const entry of state.managed) {
    const status = !existsSync(entry.source)
      ? "source-missing"
      : isClaudeHookConfig(entry)
      ? claudeHookStatus(entry)
      : isSymlinkTo(entry.target, entry.source)
      ? "ok"
      : safeLstat(entry.target)
      ? "drifted"
      : "missing";
    console.log(`${status}\t${entry.kind}\t${entry.ref}\t${entry.target} -> ${entry.source}\t${entry.harness}`);
  }
}

export async function rollback(options: Options): Promise<void> {
  let state = readState(options.statePath, options.targetDir, options.codexHome, options.claudeHome);
  state.targetDir = resolve(options.targetDir);
  state.codexHome = resolve(options.codexHome);
  state.claudeHome = resolve(options.claudeHome);
  state = detachLegacyRulesEntries(state);
  const backup = state.history.at(-1);
  if (!backup) throw new Error("rollback履歴がありません");

  const desired = backup.managed;
  validatePlan(desired, state, state.targetDir);
  console.log(`rollback先: ${backup.activeProfile ?? "(なし)"}`);
  printPlan(desired, state, [], backup.targets);
  if (!options.yes) {
    const rl = createInterface({ input, output });
    const confirmation = await rl.question("rollbackを実行しますか？ [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(confirmation.trim())) {
      console.log("中止しました");
      return;
    }
  }

  const currentBackup: Backup = {
    timestamp: new Date().toISOString(),
    activeProfile: state.activeProfile,
    targets: state.targets,
    managed: state.managed,
  };
  const settingsSnapshot = applyManagedResources(desired, state);
  const restoredState = {
    version: 4,
    codexHome: state.codexHome,
    claudeHome: state.claudeHome,
    targetDir: state.targetDir,
    activeProfile: backup.activeProfile,
    targets: backup.targets,
    managed: desired,
    history: [...state.history.slice(0, -1), currentBackup].slice(-20),
  } satisfies State;
  try {
    writeJsonAtomic(options.statePath, restoredState);
  } catch (error) {
    try {
      restoreAfterStateFailure(desired, state, settingsSnapshot);
    } catch (rollbackError) {
      throw new Error(`${String(error)} (resource復元に失敗しました: ${String(rollbackError)})`);
    }
    throw error;
  }
  console.log("rollbackが完了しました");
}
