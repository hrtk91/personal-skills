import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

type HookSettings = Record<string, unknown> & {
  hooks?: Record<string, unknown[]>;
};

type SettingsSnapshot = { path: string } & (
  | { kind: "missing" }
  | { kind: "file"; content: string; mode: number }
  | { kind: "symlink"; link: string }
);

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

function isHookConfig(entry: ManagedEntry): boolean {
  return (entry.harness === "codex" && entry.kind === "hook-config")
    || (entry.harness === "claude" && entry.kind === "claude-hook-config");
}

function linkEntries(entries: ManagedEntry[]): ManagedEntry[] {
  return entries.filter((entry) => !isHookConfig(entry));
}

function hookConfigChanges(current: ManagedEntry[], desired: ManagedEntry[]) {
  const changes = new Map<string, { previous?: ManagedEntry; desired?: ManagedEntry }>();
  for (const entry of current.filter(isHookConfig)) {
    changes.set(resolve(entry.target), { previous: entry });
  }
  for (const entry of desired.filter(isHookConfig)) {
    const target = resolve(entry.target);
    changes.set(target, { ...changes.get(target), desired: entry });
  }
  return [...changes.values()];
}

export function profileScope(profileName: string, profile: Profile, state: State): HarnessTarget[] {
  return [...new Set([
    ...profile.targets,
    ...(["codex", "claude"] as const).filter((harness) => state.profiles[harness] === profileName),
  ])];
}

export function prepareScopedState(
  state: State,
  scope: HarnessTarget[],
  options: Options,
  selectedTargets: HarnessTarget[],
): State {
  // 解除するハーネスとrollbackの導入先は、現在のoptionではなくstateを使う。
  return detachLegacyRulesEntries({
    ...state,
    ...(selectedTargets.includes("codex") ? {
      targetDir: resolve(options.targetDir),
      codexHome: resolve(options.codexHome),
    } : {}),
    ...(selectedTargets.includes("claude") ? { claudeHome: resolve(options.claudeHome) } : {}),
  }, scope);
}

export function detachLegacyRulesEntries(state: State, scope: HarnessTarget[] = ["codex", "claude"]): State {
  if (!scope.includes("codex")) return state;
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

function assertDistinctTargets(entries: ManagedEntry[]): void {
  const targetOwners = new Map<string, ManagedEntry>();
  for (const entry of entries) {
    const target = resolve(entry.target);
    const previous = targetOwners.get(target);
    if (previous && (previous.ref !== entry.ref || previous.harness !== entry.harness
      || previous.kind !== entry.kind || resolve(previous.source) !== resolve(entry.source))) {
      throw new Error(
        `導入先が衝突しています: ${previous.ref}と${entry.ref}が同じ${entry.target}を要求しています`,
      );
    }
    targetOwners.set(target, entry);
  }
}

export function validatePlan(
  desired: ManagedEntry[],
  state: State,
  targetDir: string,
  artifacts: GeneratedArtifact[] = [],
  scope: HarnessTarget[] = ["codex", "claude"],
): void {
  if (desired.some((entry) => entry.kind === "skill" && entry.name === ".system")) {
    throw new Error(".systemは保護対象のため管理できません");
  }

  const current = state.managed.filter((entry) => scope.includes(entry.harness));
  const preserved = state.managed.filter((entry) => !scope.includes(entry.harness));
  assertDistinctTargets(state.managed);
  assertDistinctTargets([...desired, ...preserved]);

  for (const entry of desired) {
    validateManagedTarget(entry, state, targetDir);
    if (isHookConfig(entry)) continue;
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

  for (const entry of current) {
    validateManagedTarget(entry, state, targetDir);
    if (isHookConfig(entry)) continue;
    const stat = safeLstat(entry.target);
    if (stat && !stat.isSymbolicLink()) {
      throw new Error(`管理対象が通常fileまたはdirectoryへ置き換えられています: ${entry.target}`);
    }
  }

  const artifactContent = new Map(artifacts.map((artifact) => [resolve(artifact.path), artifact.content]));
  for (const { previous, desired: entry } of hookConfigChanges(current, desired)) {
    mergedSettingsHooks(previous, entry, entry ? artifactContent.get(resolve(entry.source)) : undefined);
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
  return isHookConfig(entry) ? "hook" : "link";
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
  const scopedEntries = state.managed.filter((entry) => selectedTargets.includes(entry.harness));
  const current = new Map(scopedEntries.map((entry) => [resolve(entry.target), entry]));
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

  for (const entry of scopedEntries) {
    if (!next.has(resolve(entry.target))) {
      lines.push(`- ${planAction(entry)}削除 ${entry.kind} ${entry.ref} [${entry.harness}] (${entry.target})`);
    }
  }

  for (const harness of ["codex", "claude"] as const) {
    if (selectedTargets.includes(harness)) continue;
    const count = state.managed.filter((entry) => entry.harness === harness).length;
    lines.push(`= ${harness}: 変更しない（${count} 件）`);
  }

  if (desired.length === 0 && scopedEntries.length === 0) {
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
  if (isHookConfig(entry)) return;
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

function harnessLabel(entry: ManagedEntry): string {
  return entry.harness === "codex" ? "Codex" : "Claude";
}

function readHookArtifact(entry: ManagedEntry, artifactContent?: string): Record<string, unknown[]> {
  const label = harnessLabel(entry);
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifactContent ?? readFileSync(entry.source, "utf8"));
  } catch (error) {
    throw new Error(`${label} hook artifactを読み込めません ${entry.source}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} hook artifactはobjectである必要があります: ${entry.source}`);
  }
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`${label} hook artifactにhooks objectがありません: ${entry.source}`);
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${label} hook eventは配列である必要があります: ${event}`);
  }
  return hooks as Record<string, unknown[]>;
}

function settingsStat(path: string, previous?: ManagedEntry) {
  const stat = safeLstat(path);
  if (stat?.isSymbolicLink()) {
    if (previous?.harness === "codex" && previous.kind === "hook-config" && isSymlinkTo(path, previous.source)) {
      return stat;
    }
    throw new Error(`${basename(path)}が管理外symlinkのため変更できません: ${path}`);
  }
  if (stat && !stat.isFile()) throw new Error(`${basename(path)}は通常fileである必要があります: ${path}`);
  return stat;
}

function readHookSettings(path: string, previous?: ManagedEntry): HookSettings {
  if (!settingsStat(path, previous)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${basename(path)}を読み込めません ${path}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${basename(path)}はobjectである必要があります: ${path}`);
  }
  const settings = parsed as HookSettings;
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    throw new Error(`${basename(path)}のhooksはobjectである必要があります: ${path}`);
  }
  return settings;
}

function assertHooksPresent(entry: ManagedEntry, actual = readHookSettings(entry.target, entry).hooks ?? {}): void {
  const expected = readHookArtifact(entry);
  const label = harnessLabel(entry);
  for (const [event, groups] of Object.entries(expected)) {
    const current = actual[event];
    if (!Array.isArray(current)) throw new Error(`管理対象${label} hookが見つかりません: ${event} (${entry.target})`);
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
        throw new Error(`管理対象${label} hookが変更・削除・重複しています: ${event} (${entry.target})`);
      }
    }
  }
}

function snapshotSettings(path: string, previous?: ManagedEntry): SettingsSnapshot {
  const stat = settingsStat(path, previous);
  if (!stat) return { path, kind: "missing" };
  if (stat.isSymbolicLink()) return { path, kind: "symlink", link: readlinkSync(path) };
  return { path, kind: "file", content: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
}

function restoreSettingsSnapshot(snapshot: SettingsSnapshot): void {
  const current = safeLstat(snapshot.path);
  if (snapshot.kind === "symlink" && current?.isSymbolicLink() && readlinkSync(snapshot.path) === snapshot.link) return;
  if (current?.isSymbolicLink() || (current && !current.isFile())) {
    throw new Error(`${basename(snapshot.path)}が通常fileではなくなったため復元できません: ${snapshot.path}`);
  }
  if (snapshot.kind === "missing") {
    if (current) unlinkSync(snapshot.path);
  } else if (snapshot.kind === "symlink") {
    if (current) unlinkSync(snapshot.path);
    symlinkSync(snapshot.link, snapshot.path, "file");
  } else {
    if (current && readFileSync(snapshot.path, "utf8") === snapshot.content && (current.mode & 0o777) === snapshot.mode) return;
    writeSettingsFile(snapshot.path, snapshot.content, snapshot.mode);
  }
}

function writeSettingsFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode });
    // 既存fileのmodeはプロセスのumaskで狭めない。
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (safeLstat(temporary)) unlinkSync(temporary);
  }
}

function mergedSettingsHooks(previous?: ManagedEntry, desired?: ManagedEntry, artifactContent?: string): HookSettings {
  const entry = (desired ?? previous)!;
  const path = entry.target;
  const settings = readHookSettings(path, previous);
  const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };

  if (previous) {
    assertHooksPresent(previous, hooks);
    for (const [event, groups] of Object.entries(readHookArtifact(previous))) {
      const remaining = [...hooks[event]];
      for (const group of groups) {
        const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
        remaining.splice(index, 1);
      }
      if (remaining.length === 0) delete hooks[event];
      else hooks[event] = remaining;
    }
  }

  if (desired) {
    const managedHooks = readHookArtifact(desired, artifactContent);
    for (const [event, groups] of Object.entries(managedHooks)) {
      const current = hooks[event] ?? [];
      if (!Array.isArray(current)) throw new Error(`${harnessLabel(entry)} hook eventは配列である必要があります: ${event}`);
      if (groups.some((group) => current.some((candidate) => isDeepStrictEqual(candidate, group)))) {
        throw new Error(`既存hookと同じ${harnessLabel(entry)} hook groupを安全に区別できません: ${event} (${path})`);
      }
      hooks[event] = [...current, ...groups];
    }
  }

  const nextSettings: HookSettings = { ...settings };
  if (Object.keys(hooks).length === 0) delete nextSettings.hooks;
  else nextSettings.hooks = hooks;
  return nextSettings;
}

function updateSettingsHooks(previous: ManagedEntry | undefined, desired: ManagedEntry | undefined, snapshot: SettingsSnapshot): void {
  const settings = mergedSettingsHooks(previous, desired);
  // 旧Codex symlinkもrenameで通常fileへ置換し、参照先artifactは変更しない。
  writeSettingsFile(snapshot.path, `${JSON.stringify(settings, null, 2)}\n`, snapshot.kind === "file" ? snapshot.mode : 0o600);
}

function applyManagedResources(desired: ManagedEntry[], state: State): SettingsSnapshot[] {
  const changes = hookConfigChanges(state.managed, desired);
  const snapshots = changes.map(({ previous, desired }) => snapshotSettings((desired ?? previous)!.target, previous));
  try {
    applyEntries(desired, state);
    for (const [index, { previous, desired: entry }] of changes.entries()) {
      updateSettingsHooks(previous, entry, snapshots[index]);
    }
  } catch (error) {
    try {
      restoreAfterStateFailure(desired, state, snapshots);
    } catch (rollbackError) {
      throw new Error(`${String(error)} (resource復元に失敗しました: ${String(rollbackError)})`);
    }
    throw error;
  }
  return snapshots;
}

function restoreAfterStateFailure(
  desired: ManagedEntry[],
  state: State,
  settingsSnapshots: SettingsSnapshot[],
): void {
  const errors: string[] = [];
  try {
    applyEntries(linkEntries(state.managed), { ...state, managed: linkEntries(desired) });
  } catch (error) {
    errors.push(`symlink復元: ${String(error)}`);
  }
  for (const snapshot of [...settingsSnapshots].reverse()) {
    try {
      restoreSettingsSnapshot(snapshot);
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
  const scope = profileScope(profileName, profile, state);
  state = prepareScopedState(state, scope, options, profile.targets);
  const plan = desiredPlan(
    profile,
    state.targetDir,
    state.codexHome,
    state.claudeHome,
    options.statePath,
    config,
  );
  const desired = plan.entries;
  validatePlan(desired, state, state.targetDir, plan.artifacts, scope);
  printPlan(desired, state, plan.notices, scope);

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
    profiles: state.profiles,
    managed: state.managed,
  };
  for (const artifact of plan.artifacts) {
    if (!existsSync(artifact.path)) writeArtifact(artifact);
  }
  const scopedState = { ...state, managed: state.managed.filter((entry) => scope.includes(entry.harness)) };
  const settingsSnapshots = applyManagedResources(desired, scopedState);
  const profiles = { ...state.profiles };
  for (const harness of scope) delete profiles[harness];
  for (const harness of profile.targets) profiles[harness] = profileName;
  const nextState: State = {
    version: 4,
    codexHome: state.codexHome,
    claudeHome: state.claudeHome,
    targetDir: state.targetDir,
    activeProfile: profileName,
    targets: profile.targets,
    profiles,
    managed: [...state.managed.filter((entry) => !scope.includes(entry.harness)), ...desired],
    history: [...state.history, backup].slice(-20),
  };
  try {
    writeJsonAtomic(options.statePath, nextState);
  } catch (error) {
    try {
      restoreAfterStateFailure(desired, scopedState, settingsSnapshots);
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

function hookConfigStatus(entry: ManagedEntry): "ok" | "drifted" | "missing" {
  if (!existsSync(entry.source) || !existsSync(entry.target)) return "missing";
  try {
    assertHooksPresent(entry);
    return "ok";
  } catch {
    return "drifted";
  }
}

export function inspectStatus(state: State): void {
  console.log(`skill導入先 (Codex): ${resolve(state.targetDir)}`);
  console.log(`Codex home: ${resolve(state.codexHome)}`);
  console.log(`Claude home: ${resolve(state.claudeHome)}`);
  for (const harness of ["codex", "claude"] as const) {
    console.log(`有効なprofile [${harness}]: ${state.profiles[harness] ?? "(なし)"}`);
  }
  if (state.managed.length === 0) {
    console.log("管理対象resource: なし");
    return;
  }
  for (const entry of state.managed) {
    const status = !existsSync(entry.source)
      ? "source-missing"
      : isHookConfig(entry)
      ? hookConfigStatus(entry)
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
  let backup = state.history.at(-1);
  if (!backup) throw new Error("rollback履歴がありません");

  const scope = (["codex", "claude"] as const).filter((harness) =>
    state.profiles[harness] !== backup!.profiles[harness]
    || !isDeepStrictEqual(
      state.managed.filter((entry) => entry.harness === harness),
      backup!.managed.filter((entry) => entry.harness === harness),
    ));
  state = prepareScopedState(state, scope, options, []);
  backup = state.history.at(-1)!;
  const desired = backup.managed.filter((entry) => scope.includes(entry.harness));
  validatePlan(desired, state, state.targetDir, [], scope);
  console.log(`rollback先: ${backup.activeProfile ?? "(なし)"}`);
  printPlan(desired, state, [], scope);
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
    profiles: state.profiles,
    managed: state.managed,
  };
  const scopedState = { ...state, managed: state.managed.filter((entry) => scope.includes(entry.harness)) };
  const settingsSnapshots = applyManagedResources(desired, scopedState);
  const restoredState = {
    version: 4,
    codexHome: state.codexHome,
    claudeHome: state.claudeHome,
    targetDir: state.targetDir,
    activeProfile: backup.activeProfile,
    targets: backup.targets,
    profiles: backup.profiles,
    managed: backup.managed,
    history: [...state.history.slice(0, -1), currentBackup].slice(-20),
  } satisfies State;
  try {
    writeJsonAtomic(options.statePath, restoredState);
  } catch (error) {
    try {
      restoreAfterStateFailure(desired, scopedState, settingsSnapshots);
    } catch (rollbackError) {
      throw new Error(`${String(error)} (resource復元に失敗しました: ${String(rollbackError)})`);
    }
    throw error;
  }
  console.log("rollbackが完了しました");
}
