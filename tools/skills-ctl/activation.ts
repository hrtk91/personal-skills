import {
  existsSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type Backup,
  type Config,
  type ManagedEntry,
  type Options,
  type Profile,
  type State,
  readState,
  safeLstat,
  writeJsonAtomic,
} from "./model.ts";
import { type GeneratedArtifact, desiredPlan } from "./profile-plan.ts";

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
  return state.managed.find((entry) => entry.target === target);
}

export function validatePlan(
  desired: ManagedEntry[],
  state: State,
  targetDir: string,
): void {
  if (desired.some((entry) => entry.name === ".system")) {
    throw new Error(".systemは保護対象のため管理できません");
  }

  const targetOwners = new Map<string, ManagedEntry>();
  for (const entry of desired) {
    validateManagedTarget(entry, state, targetDir);
    const previous = targetOwners.get(entry.target);
    if (previous && previous.ref !== entry.ref) {
      throw new Error(
        `導入先が衝突しています: ${previous.ref}と${entry.ref}が同じ${entry.target}を要求しています`,
      );
    }
    targetOwners.set(entry.target, entry);
  }

  if (desired.some((entry) => entry.kind === "rules")) {
    const override = join(state.codexHome, "AGENTS.override.md");
    if (safeLstat(override)) {
      throw new Error(`AGENTS.override.mdが常時ルールを無効にします: ${override}`);
    }
  }

  for (const entry of desired) {
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
    const stat = safeLstat(entry.target);
    if (stat && !stat.isSymbolicLink()) {
      throw new Error(`管理対象が通常fileまたはdirectoryへ置き換えられています: ${entry.target}`);
    }
  }
}

export function validateManagedTarget(entry: ManagedEntry, state: State, targetDir: string): void {
  const target = resolve(entry.target);
  const codexHome = resolve(state.codexHome);
  if (entry.kind === "skill" && dirname(target) === resolve(targetDir)) return;
  if (entry.kind === "rules" && target === join(codexHome, "AGENTS.md")) return;
  if (entry.kind === "hook-config" && target === join(codexHome, "hooks.json")) return;
  const hookRoot = join(codexHome, "managed-hooks");
  if (entry.kind === "hook-package" && target.startsWith(`${hookRoot}/`)) return;
  throw new Error(`state entryが${entry.kind}の許可範囲外です: ${entry.target}`);
}

export function planLines(
  desired: ManagedEntry[],
  state: State,
): string[] {
  const lines = [
    `skill導入先: ${resolve(state.targetDir)}`,
    `Codex home: ${resolve(state.codexHome)}`,
    `導入予定resource: ${desired.length}件`,
  ];
  const current = new Map(state.managed.map((entry) => [entry.target, entry]));
  const next = new Map(desired.map((entry) => [entry.target, entry]));

  for (const entry of desired) {
    const previous = current.get(entry.target);
    if (!previous) {
      lines.push(`+ link追加 ${entry.kind} ${entry.ref} -> ${entry.source}`);
    } else if (resolve(previous.source) !== resolve(entry.source)) {
      lines.push(`~ link更新 ${entry.kind} ${entry.ref}: ${previous.source} -> ${entry.source}`);
    } else {
      lines.push(`= 維持 ${entry.kind} ${entry.ref}`);
    }
  }

  for (const entry of state.managed) {
    if (!next.has(entry.target)) lines.push(`- link削除 ${entry.kind} ${entry.ref} (${entry.target})`);
  }

  if (desired.length === 0 && state.managed.length === 0) {
    lines.push("= 管理対象resourceなし");
  }
  return lines;
}

export function printPlan(desired: ManagedEntry[], state: State): void {
  for (const line of planLines(desired, state)) console.log(line);
}

export function unlinkIfManaged(entry: ManagedEntry, state: State): void {
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
  const desiredByTarget = new Map(desired.map((entry) => [entry.target, entry]));
  const changed: string[] = [];

  try {
    mkdirSync(state.targetDir, { recursive: true });

    for (const previous of state.managed) {
      if (!desiredByTarget.has(previous.target)) {
        unlinkIfManaged(previous, state);
        changed.push(previous.target);
      }
    }

    for (const entry of desired) {
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
    for (const entry of state.managed) {
      if (safeLstat(entry.target)) continue;
      mkdirSync(dirname(entry.target), { recursive: true });
      symlinkSync(entry.source, entry.target, entry.linkType);
    }
    throw error;
  }
}

export async function applyProfile(
  profileName: string,
  profile: Profile,
  config: Config,
  options: Options,
): Promise<void> {
  const state = readState(options.statePath, options.targetDir, options.codexHome);
  state.targetDir = resolve(options.targetDir);
  state.codexHome = resolve(options.codexHome);
  const plan = desiredPlan(profile, state.targetDir, state.codexHome, options.statePath, config);
  const desired = plan.entries;
  validatePlan(desired, state, state.targetDir);
  printPlan(desired, state);

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
    managed: state.managed,
  };
  for (const artifact of plan.artifacts) {
    if (!existsSync(artifact.path)) writeJsonArtifact(artifact);
  }
  applyEntries(desired, state);
  const nextState: State = {
    version: 3,
    codexHome: state.codexHome,
    targetDir: state.targetDir,
    activeProfile: profileName,
    managed: desired,
    history: [...state.history, backup].slice(-20),
  };
  try {
    writeJsonAtomic(options.statePath, nextState);
  } catch (error) {
    applyEntries(state.managed, { ...state, managed: desired });
    throw error;
  }
  console.log(`profileを適用しました: ${profileName}`);
  if (profile.rules) console.log("常時ルールは次のCodex runから有効です");
}

export function writeJsonArtifact(artifact: GeneratedArtifact): void {
  mkdirSync(dirname(artifact.path), { recursive: true });
  const temporary = `${artifact.path}.${process.pid}.tmp`;
  writeFileSync(temporary, artifact.content, { mode: 0o600 });
  renameSync(temporary, artifact.path);
}

export function inspectStatus(state: State): void {
  console.log(`導入先: ${resolve(state.targetDir)}`);
  console.log(`有効なprofile: ${state.activeProfile ?? "(なし)"}`);
  if (state.managed.length === 0) {
    console.log("管理対象resource: なし");
    return;
  }
  for (const entry of state.managed) {
    const status = !existsSync(entry.source)
      ? "source-missing"
      : isSymlinkTo(entry.target, entry.source)
      ? "ok"
      : safeLstat(entry.target)
      ? "drifted"
      : "missing";
    console.log(`${status}\t${entry.kind}\t${entry.ref}\t${entry.target} -> ${entry.source}`);
  }
}

export async function rollback(options: Options): Promise<void> {
  const state = readState(options.statePath, options.targetDir, options.codexHome);
  const backup = state.history.at(-1);
  if (!backup) throw new Error("rollback履歴がありません");

  const desired = backup.managed;
  validatePlan(desired, state, state.targetDir);
  console.log(`rollback先: ${backup.activeProfile ?? "(なし)"}`);
  printPlan(desired, state);
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
    managed: state.managed,
  };
  applyEntries(desired, state);
  const restoredState = {
    version: 3,
    codexHome: state.codexHome,
    targetDir: state.targetDir,
    activeProfile: backup.activeProfile,
    managed: desired,
    history: [...state.history.slice(0, -1), currentBackup].slice(-20),
  } satisfies State;
  try {
    writeJsonAtomic(options.statePath, restoredState);
  } catch (error) {
    applyEntries(state.managed, { ...state, managed: desired });
    throw error;
  }
  console.log("rollbackが完了しました");
}
