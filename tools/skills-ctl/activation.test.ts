import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { type Config, type HarnessTarget, type State } from "./model.ts";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = process.env.HARNESSCTL_TEST_CLI ?? join(repoRoot, "tools", "skills-ctl.ts");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "harness-scope-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "skills", "sample"), { recursive: true });
  writeFileSync(join(source, "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\n");
  for (const name of ["first", "second"]) {
    mkdirSync(join(source, "hooks", name), { recursive: true });
    writeFileSync(join(source, "hooks", name, "hooks.json"), JSON.stringify({
      targets: ["codex", "claude"],
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `echo managed-${name}` }] }] },
    }));
  }
  const profiles: Config["profiles"] = {};
  for (const [name, targets] of [
    ["codex", ["codex"]],
    ["claude", ["claude"]],
    ["both", ["codex", "claude"]],
    ["emptyCodex", ["codex"]],
    ["emptyClaude", ["claude"]],
  ] as const) {
    profiles[name] = {
      targets: [...targets],
      skills: name.startsWith("empty") ? [] : ["fixture:sample"],
      rules: [],
      hooks: [],
    };
  }
  const config: Config = {
    version: 5,
    sources: { fixture: { path: source } },
    profiles,
  };
  const saveConfig = () => writeFileSync(join(root, "profiles.json"), JSON.stringify(config));
  saveConfig();
  const run = (...args: string[]) => execFileSync(process.execPath, [
    cli, ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PERSONAL_SKILLS_CONFIG: join(root, "profiles.json"),
      PERSONAL_SKILLS_STATE: join(root, "state.json"),
      PERSONAL_SKILLS_TARGET: join(root, "codex", "skills"),
      PERSONAL_SKILLS_CODEX_HOME: join(root, "codex"),
      PERSONAL_SKILLS_CLAUDE_HOME: join(root, "claude"),
    },
  });
  const state = (): State => JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  const saveState = (value: unknown) => writeFileSync(join(root, "state.json"), JSON.stringify(value));
  return { root, source, config, saveConfig, run, state, saveState };
}

for (const [first, second] of [["codex", "claude"], ["claude", "codex"]] as const) {
  test(`${first}の後に${second}をapplyしても範囲外のskillとprofileを保持する`, (t) => {
    const f = fixture(t);
    f.run("apply", first, "--yes");
    const target = join(f.root, first, "skills", "sample");
    const inode = lstatSync(target).ino;
    const before = f.state().managed;
    const plan = f.run("plan", second);
    assert.match(plan, new RegExp(`${first}: 変更しない（1 件）`));
    assert.doesNotMatch(plan, /削除/);
    f.run("apply", second, "--yes");
    assert.equal(lstatSync(target).ino, inode);
    assert.deepEqual(f.state().managed.filter((entry) => entry.harness === first), before);
    assert.deepEqual(f.state().profiles, { [first]: first, [second]: second });
    assert.match(f.run("status"), /有効なprofile \[codex\]: codex/);
    assert.match(f.run("status"), /有効なprofile \[claude\]: claude/);
    f.run("rollback", "--yes");
    assert.equal(lstatSync(target).ino, inode);
    assert.deepEqual(f.state().profiles, { [first]: first });
    assert.equal(existsSync(join(f.root, second, "skills", "sample")), false);
  });
}

test("同じprofileのtargetsを縮めると外したハーネスだけを解除し、rollbackで戻せる", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, "rules", "policy"), { recursive: true });
  writeFileSync(join(f.source, "rules", "policy", "AGENTS.md"), "# fixture policy\n");
  f.config.profiles.both.rules = ["fixture:policy"];
  f.config.profiles.both.hooks = ["fixture:first"];
  f.saveConfig();
  f.run("apply", "both", "--yes");
  const codexEntries = f.state().managed.filter((entry) => entry.harness === "codex");
  const codexHooks = readFileSync(hookPath(f.root, "codex"), "utf8");
  const codexTarget = join(f.root, "codex", "skills", "sample");
  const inode = lstatSync(codexTarget).ino;
  f.config.profiles.both.targets = ["codex"];
  f.saveConfig();
  assert.match(f.run("plan", "both"), /link削除 skill fixture:sample \[claude\]/);
  f.run("apply", "both", "--yes");
  assert.equal(lstatSync(codexTarget).ino, inode);
  assert.deepEqual(f.state().managed, codexEntries);
  assert.equal(readFileSync(hookPath(f.root, "codex"), "utf8"), codexHooks);
  assert.equal(existsSync(join(f.root, "claude", "skills", "sample")), false);
  assert.equal(existsSync(join(f.root, "claude", "rules", "harnessctl-personal-skills.md")), false);
  assert.equal(existsSync(join(f.root, "claude", "managed-hooks", "fixture", "first")), false);
  assert.deepEqual(readHooks(hookPath(f.root, "claude")), {});
  assert.deepEqual(f.state().profiles, { codex: "both" });
  f.run("rollback", "--yes");
  assert.deepEqual(f.state().profiles, { codex: "both", claude: "both" });
  assert.equal(lstatSync(join(f.root, "claude", "skills", "sample")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(f.root, "claude", "rules", "harnessctl-personal-skills.md")).isSymbolicLink(), true);
  assert.equal(readHooks(hookPath(f.root, "claude")).hooks!.PreToolUse.length, 1);
  f.config.profiles.both.targets = [];
  f.saveConfig();
  f.run("apply", "both", "--yes");
  assert.deepEqual(f.state().managed, []);
  assert.deepEqual(f.state().profiles, {});
  assert.deepEqual(readHooks(hookPath(f.root, "codex")), {});
  assert.deepEqual(readHooks(hookPath(f.root, "claude")), {});
});

for (const removed of ["codex", "claude"] as const) {
  test(`targetsから外した${removed}は保存済みの導入先で解除・rollbackする`, (t) => {
    const f = fixture(t);
    const kept = removed === "codex" ? "claude" : "codex";
    const customHome = join(f.root, `custom-${removed}`);
    const homeOptions = [`--${removed}-home`, customHome,
      ...(removed === "codex" ? ["--target-dir", join(customHome, "skills")] : [])];
    f.config.profiles.both.hooks = ["fixture:first"];
    f.saveConfig();
    f.run("apply", "both", "--yes", ...homeOptions);
    const before = f.state();
    const keptPath = hookPath(f.root, kept);
    const keptHooks = readFileSync(keptPath, "utf8");
    const removedPath = join(customHome, removed === "codex" ? "hooks.json" : "settings.json");
    const settings = { ...readHooks(removedPath), description: "keep custom settings" };
    writeFileSync(removedPath, JSON.stringify(settings));
    f.config.profiles.both.targets = [kept];
    f.saveConfig();

    assert.match(f.run("plan", "both"), new RegExp(`hook削除 .*\\[${removed}\\]`));
    f.run("apply", "both", "--yes");
    assert.equal(existsSync(join(customHome, "skills", "sample")), false);
    assert.deepEqual(readHooks(removedPath), { description: "keep custom settings" });
    assert.equal(readFileSync(keptPath, "utf8"), keptHooks);
    assert.equal(f.state()[removed === "codex" ? "codexHome" : "claudeHome"], customHome);
    assert.equal(existsSync(hookPath(f.root, removed)), false);

    f.run("rollback", "--yes");
    assert.deepEqual(f.state().profiles, before.profiles);
    assert.deepEqual(f.state().managed, before.managed);
    assert.equal(lstatSync(join(customHome, "skills", "sample")).isSymbolicLink(), true);
    assert.deepEqual(readHooks(removedPath), settings);
    assert.equal(readFileSync(keptPath, "utf8"), keptHooks);
  });
}

test("別profileへ引き継いだハーネスは元profileのtargets縮小で解除しない", (t) => {
  const f = fixture(t);
  f.run("apply", "both", "--yes");
  f.run("apply", "claude", "--yes");
  f.config.profiles.both.targets = ["codex"];
  f.saveConfig();
  assert.match(f.run("plan", "both"), /claude: 変更しない（1 件）/);
  f.run("apply", "both", "--yes");
  assert.deepEqual(f.state().profiles, { codex: "both", claude: "claude" });
  assert.equal(lstatSync(join(f.root, "claude", "skills", "sample")).isSymbolicLink(), true);
});

for (const [outside, inside] of [["codex", "claude"], ["claude", "codex"]] as const) {
  test(`${outside}の範囲外driftはstatusに出し、${inside}のplan/apply/rollbackを妨げない`, (t) => {
    const f = fixture(t);
    f.run("apply", outside, "--yes");
    const target = join(f.root, outside, "skills", "sample");
    rmSync(target);
    writeFileSync(target, "user replacement");
    const inode = lstatSync(target).ino;
    assert.match(f.run("status"), /drifted\tskill/);
    f.run("plan", inside);
    f.run("apply", inside, "--yes");
    f.run("rollback", "--yes");
    assert.equal(readFileSync(target, "utf8"), "user replacement");
    assert.equal(lstatSync(target).ino, inode);
    assert.deepEqual(f.state().profiles, { [outside]: outside });
  });
}

test("profilesのないversion 4 stateとhistoryからstatus/apply/rollbackできる", (t) => {
  const f = fixture(t);
  f.run("apply", "codex", "--yes");
  const legacy = f.state();
  Reflect.deleteProperty(legacy, "profiles");
  legacy.history.forEach((backup) => Reflect.deleteProperty(backup, "profiles"));
  f.saveState(legacy);
  assert.match(f.run("status"), /有効なprofile \[codex\]: codex/);
  f.run("plan", "claude");
  f.run("apply", "claude", "--yes");
  assert.deepEqual(f.state().profiles, { codex: "codex", claude: "claude" });
  f.run("rollback", "--yes");
  assert.deepEqual(f.state().profiles, { codex: "codex" });
  f.run("apply", "emptyCodex", "--yes");
  const beforeRollback = f.state();
  Reflect.deleteProperty(beforeRollback, "profiles");
  beforeRollback.history.forEach((backup) => Reflect.deleteProperty(backup, "profiles"));
  f.saveState(beforeRollback);
  f.run("rollback", "--yes");
  assert.deepEqual(f.state().profiles, { codex: "codex" });
  assert.equal(lstatSync(join(f.root, "codex", "skills", "sample")).isSymbolicLink(), true);
});

test("範囲外entryと同じ導入先を要求すると、symlinkが無くても衝突を検出する", (t) => {
  const f = fixture(t);
  f.run("apply", "claude", "--yes");
  const before = readFileSync(join(f.root, "state.json"), "utf8");
  rmSync(join(f.root, "claude", "skills", "sample"));
  for (const command of ["plan", "apply"]) {
    assert.throws(() => f.run(command, "codex", "--target-dir", join(f.root, "claude", "skills"), "--yes"), /導入先が衝突しています/);
  }
  assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), before);
});

test("削除対象と範囲外entryが同じ導入先を記録しているstateも拒否する", (t) => {
  const f = fixture(t);
  f.run("apply", "claude", "--yes");
  const state = f.state();
  state.managed.push({ ...state.managed[0], harness: "codex" });
  state.profiles.codex = "codex";
  f.saveState(state);
  const before = readFileSync(join(f.root, "state.json"), "utf8");
  for (const command of ["plan", "apply"]) {
    assert.throws(() => f.run(command, "emptyCodex", "--target-dir", join(f.root, "claude", "skills"), "--yes"), /導入先が衝突しています/);
  }
  assert.equal(lstatSync(join(f.root, "claude", "skills", "sample")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), before);
});

test("範囲外の旧AGENTS.md entryと導入先設定を検査・書き換えしない", (t) => {
  const f = fixture(t);
  f.run("apply", "codex", "--yes");
  const legacy = f.state();
  const source = join(f.root, "old-rules.md");
  const target = join(f.root, "codex", "AGENTS.md");
  writeFileSync(source, "old rules");
  symlinkSync(source, target);
  legacy.managed.push({ harness: "codex", kind: "rules", linkType: "file", ref: "generated:legacy", sourceId: "generated", name: "legacy", source, target });
  f.saveState(legacy);
  f.run("plan", "claude", "--codex-home", join(f.root, "unused-codex"));
  f.run("apply", "claude", "--yes", "--codex-home", join(f.root, "unused-codex"));
  assert.deepEqual(f.state().managed.filter((entry) => entry.harness === "codex"), legacy.managed);
  assert.equal(f.state().codexHome, legacy.codexHome);
  assert.equal(f.state().targetDir, legacy.targetDir);
  f.run("rollback", "--yes");
  assert.equal(readlinkSync(target), source);
});

function userGroup(command: string) {
  return { hooks: [{ type: "command", command }] };
}

type HookDocument = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

function hookPath(root: string, harness: HarnessTarget): string {
  return join(root, harness, harness === "codex" ? "hooks.json" : "settings.json");
}

function readHooks(path: string): HookDocument {
  return JSON.parse(readFileSync(path, "utf8"));
}

function legacyCodex(f: ReturnType<typeof fixture>) {
  f.config.profiles.codex.hooks = ["fixture:first"];
  f.saveConfig();
  f.run("apply", "codex", "--yes");
  const state = f.state();
  const entry = state.managed.find((entry) => entry.kind === "hook-config")!;
  const link = relative(dirname(entry.target), entry.source);
  rmSync(entry.target);
  symlinkSync(link, entry.target);
  Reflect.deleteProperty(state, "profiles");
  state.history.forEach((backup) => Reflect.deleteProperty(backup, "profiles"));
  f.saveState(state);
  return { entry, link, artifact: readFileSync(entry.source, "utf8") };
}

for (const harness of ["codex", "claude"] as const) {
  for (const operation of ["apply", "state-failure"] as const) {
    test(`${harness}の${operation}はumaskにかかわらず既存hook設定のmodeを保持する`, (t) => {
      const f = fixture(t);
      f.config.profiles[harness].hooks = ["fixture:first"];
      f.saveConfig();
      f.run("apply", harness, "--yes");
      const path = hookPath(f.root, harness);
      chmodSync(path, 0o640);
      const before = readFileSync(path, "utf8");
      const stateBefore = readFileSync(join(f.root, "state.json"), "utf8");
      const oldMask = process.umask(0o077);
      try {
        if (operation === "state-failure") {
          chmodSync(f.root, 0o500);
          assertWriteFailure(() => f.run("apply", harness === "codex" ? "emptyCodex" : "emptyClaude", "--yes"), /state\.json\.\d+\.tmp/);
        } else {
          f.run("apply", harness, "--yes");
        }
      } finally {
        process.umask(oldMask);
        chmodSync(f.root, 0o700);
      }
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(lstatSync(path).mode & 0o777, 0o640);
      if (operation === "state-failure") assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), stateBefore);
    });
  }

  test(`${harness}のhook追加・切替・解除・rollbackは管理外groupと他keyを保持する`, (t) => {
    const f = fixture(t);
    const path = hookPath(f.root, harness);
    mkdirSync(dirname(path), { recursive: true });
    const userSettings = {
      description: "user description",
      other: { enabled: true },
      hooks: {
        PreToolUse: [userGroup("echo user-tool")],
        PreCompact: [userGroup("echo user-compact")],
        SessionStart: [userGroup("echo user-session")],
      },
    };
    writeFileSync(path, JSON.stringify(userSettings), { mode: 0o640 });
    f.config.profiles[harness].hooks = ["fixture:first"];
    f.config.profiles.next = { ...f.config.profiles[harness], hooks: ["fixture:second"] };
    f.saveConfig();
    assert.match(f.run("plan", harness), /hook追加/);
    f.run("apply", harness, "--yes");
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(lstatSync(path).mode & 0o777, 0o640);
    assert.deepEqual(readHooks(path), {
      ...userSettings,
      hooks: { ...userSettings.hooks, PreToolUse: [...userSettings.hooks.PreToolUse, { matcher: "Bash", ...userGroup("echo managed-first") }] },
    });
    assert.match(f.run("plan", "next"), /hook更新/);
    f.run("apply", "next", "--yes");
    assert.deepEqual(readHooks(path).hooks!.PreToolUse, [userSettings.hooks.PreToolUse[0], { matcher: "Bash", ...userGroup("echo managed-second") }]);
    const emptyProfile = harness === "codex" ? "emptyCodex" : "emptyClaude";
    assert.match(f.run("plan", emptyProfile), /hook削除/);
    f.run("apply", emptyProfile, "--yes");
    assert.deepEqual(readHooks(path), userSettings);
    const laterSettings = { ...userSettings, description: "edited after removal" };
    writeFileSync(path, JSON.stringify(laterSettings));
    f.run("rollback", "--yes");
    assert.deepEqual(readHooks(path), {
      ...laterSettings,
      hooks: { ...laterSettings.hooks, PreToolUse: [...laterSettings.hooks.PreToolUse, { matcher: "Bash", ...userGroup("echo managed-second") }] },
    });
    assert.match(f.run("status"), /ok\t(?:claude-)?hook-config/);
  });

  test(`${harness}のhook設定が無ければ作成し、最後の管理groupを外すとhooksキーを消す`, (t) => {
    const f = fixture(t);
    const path = hookPath(f.root, harness);
    f.config.profiles[harness].hooks = ["fixture:first"];
    f.saveConfig();
    assert.equal(existsSync(path), false);
    f.run("apply", harness, "--yes");
    assert.equal(lstatSync(path).isFile(), true);
    writeFileSync(path, JSON.stringify({ ...readHooks(path), description: "keep" }));
    f.run("apply", harness === "codex" ? "emptyCodex" : "emptyClaude", "--yes");
    assert.deepEqual(readHooks(path), { description: "keep" });
  });
}

test("旧Codex symlinkはplan/dry-runで変更せずapplyで通常fileへ移行する", (t) => {
  const f = fixture(t);
  const { entry, link, artifact } = legacyCodex(f);
  const before = readFileSync(join(f.root, "state.json"), "utf8");
  assert.match(f.run("status"), /ok\thook-config/);
  f.run("plan", "codex");
  f.run("apply", "codex", "--dry-run");
  assert.equal(readlinkSync(entry.target), link);
  assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), before);
  f.run("apply", "codex", "--yes");
  assert.equal(lstatSync(entry.target).isFile(), true);
  assert.deepEqual(readHooks(entry.target), JSON.parse(artifact));
  assert.equal(readFileSync(entry.source, "utf8"), artifact);
  assert.deepEqual(f.state().profiles, { codex: "codex" });
});

test("旧Codex通常fileにPreCompact/SessionStartが追加されてもplan/apply/statusとClaude適用が通る", (t) => {
  const f = fixture(t);
  const { entry, artifact } = legacyCodex(f);
  const expected = JSON.parse(artifact) as HookDocument;
  expected.description = "user added hooks";
  expected.hooks!.PreCompact = [userGroup("echo dummy-compact")];
  expected.hooks!.SessionStart = [userGroup("echo dummy-session")];
  rmSync(entry.target);
  writeFileSync(entry.target, JSON.stringify(expected));
  assert.equal(expected.hooks!.PreToolUse.length, 1);
  assert.match(f.run("plan", "codex"), /= 維持 hook-config/);
  f.run("apply", "codex", "--yes");
  assert.match(f.run("status"), /ok\thook-config/);
  assert.deepEqual(readHooks(entry.target), expected);
  const beforeClaude = readFileSync(entry.target, "utf8");
  const inode = lstatSync(entry.target).ino;
  f.run("apply", "claude", "--yes");
  assert.equal(readFileSync(entry.target, "utf8"), beforeClaude);
  assert.equal(lstatSync(entry.target).ino, inode);
  assert.deepEqual(f.state().profiles, { codex: "codex", claude: "claude" });
  assert.equal(lstatSync(join(f.root, "codex", "skills", "sample")).isSymbolicLink(), true);
  f.run("rollback", "--yes");
  assert.equal(readFileSync(entry.target, "utf8"), beforeClaude);
  assert.equal(lstatSync(entry.target).ino, inode);
});

for (const corruption of ["missing", "changed", "duplicate", "absent"] as const) {
  test(`旧Codex管理groupが${corruption}ならplan/applyは停止しstatusに反映する`, (t) => {
    const f = fixture(t);
    const { entry, artifact } = legacyCodex(f);
    rmSync(entry.target);
    if (corruption !== "absent") {
      const settings = JSON.parse(artifact) as HookDocument;
      if (corruption === "missing") delete settings.hooks!.PreToolUse;
      if (corruption === "changed") settings.hooks!.PreToolUse = [userGroup("echo changed")];
      if (corruption === "duplicate") settings.hooks!.PreToolUse.push(settings.hooks!.PreToolUse[0]);
      writeFileSync(entry.target, JSON.stringify(settings));
    }
    const before = existsSync(entry.target) ? readFileSync(entry.target, "utf8") : null;
    assert.match(f.run("status"), new RegExp(`${corruption === "absent" ? "missing" : "drifted"}\\thook-config`));
    for (const command of ["plan", "apply"]) {
      assert.throws(() => f.run(command, "codex", "--yes"), /管理対象Codex hook/);
    }
    assert.equal(existsSync(entry.target) ? readFileSync(entry.target, "utf8") : null, before);
  });
}

test("旧historyのhook-configへrollbackしても通常fileとして管理外hookを保持する", (t) => {
  const f = fixture(t);
  const { entry } = legacyCodex(f);
  f.run("apply", "emptyCodex", "--yes");
  const beforeRollback = f.state();
  Reflect.deleteProperty(beforeRollback, "profiles");
  beforeRollback.history.forEach((backup) => Reflect.deleteProperty(backup, "profiles"));
  f.saveState(beforeRollback);
  const settings = { description: "after removal", hooks: { SessionStart: [userGroup("echo later")] } };
  writeFileSync(entry.target, JSON.stringify(settings));
  f.run("rollback", "--yes");
  assert.equal(lstatSync(entry.target).isFile(), true);
  assert.deepEqual(readHooks(entry.target), {
    ...settings,
    hooks: { ...settings.hooks, PreToolUse: [{ matcher: "Bash", ...userGroup("echo managed-first") }] },
  });
  assert.match(f.run("status"), /ok\thook-config/);
  assert.deepEqual(f.state().profiles, { codex: "codex" });
});

for (const outside of ["codex", "claude"] as const) {
  test(`範囲外${outside}のhook設定が壊れていてもapply/rollbackは読み書きしない`, (t) => {
    const f = fixture(t);
    const inside = outside === "codex" ? "claude" : "codex";
    f.config.profiles[outside].hooks = ["fixture:first"];
    f.saveConfig();
    f.run("apply", outside, "--yes");
    const path = hookPath(f.root, outside);
    writeFileSync(path, "broken JSON");
    const inode = lstatSync(path).ino;
    assert.match(f.run("status"), /drifted\t(?:claude-)?hook-config/);
    f.run("plan", inside);
    f.run("apply", inside, "--yes");
    f.run("rollback", "--yes");
    assert.equal(lstatSync(path).ino, inode);
    assert.equal(readFileSync(path, "utf8"), "broken JSON");
  });
}

function assertWriteFailure(action: () => unknown, pathPattern: RegExp): void {
  assert.throws(action, (error) => {
    assert.match(String(error), /permission|EACCES/i);
    assert.match(String(error), pathPattern);
    assert.doesNotMatch(String(error), /resource復元に失敗/);
    return true;
  });
}

for (const representation of ["file", "symlink"] as const) {
  for (const operation of ["apply", "rollback"] as const) {
    test(`${operation}のstate保存失敗はCodexの元${representation}・mode・管理linkを復元する`, (t) => {
      const f = fixture(t);
      legacyCodex(f);
      if (operation === "rollback") {
        f.config.profiles.next = { ...f.config.profiles.codex, hooks: ["fixture:second"] };
        f.saveConfig();
        f.run("apply", "next", "--yes");
      }
      const entry = f.state().managed.find((entry) => entry.kind === "hook-config")!;
      rmSync(entry.target);
      const link = relative(dirname(entry.target), entry.source);
      const artifact = readFileSync(entry.source, "utf8");
      if (representation === "symlink") symlinkSync(link, entry.target);
      else writeFileSync(entry.target, `  ${JSON.stringify({ ...JSON.parse(artifact), description: "user before failure" })}\n`, { mode: 0o640 });
      const before = readFileSync(entry.target, "utf8");
      const stateBefore = readFileSync(join(f.root, "state.json"), "utf8");
      chmodSync(f.root, 0o500);
      try {
        assertWriteFailure(() => operation === "apply"
          ? f.run("apply", "emptyCodex", "--yes")
          : f.run("rollback", "--yes"), /state\.json\.\d+\.tmp/);
      } finally {
        chmodSync(f.root, 0o700);
      }
      assert.equal(readFileSync(entry.target, "utf8"), before);
      assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), stateBefore);
      assert.equal(readFileSync(entry.source, "utf8"), artifact);
      assert.equal(lstatSync(entry.target).isSymbolicLink(), representation === "symlink");
      if (representation === "symlink") assert.equal(readlinkSync(entry.target), link);
      else assert.equal(lstatSync(entry.target).mode & 0o777, 0o640);
      assert.equal(lstatSync(join(f.root, "codex", "skills", "sample")).isSymbolicLink(), true);
      const packageEntry = f.state().managed.find((entry) => entry.kind === "hook-package")!;
      assert.equal(readlinkSync(packageEntry.target), packageEntry.source);
      assert.match(f.run("status"), /ok\thook-config/);
    });
  }

  test(`2つ目の設定更新失敗で先に更新したCodexの${representation}とClaude設定を復元する`, (t) => {
    const f = fixture(t);
    f.config.profiles.both.hooks = ["fixture:first"];
    f.saveConfig();
    f.run("apply", "both", "--yes");
    const entry = f.state().managed.find((entry) => entry.kind === "hook-config")!;
    const link = relative(dirname(entry.target), entry.source);
    if (representation === "symlink") {
      rmSync(entry.target);
      symlinkSync(link, entry.target);
    }
    const codexBefore = readFileSync(entry.target, "utf8");
    const claudePath = hookPath(f.root, "claude");
    const claudeBefore = readFileSync(claudePath, "utf8");
    const stateBefore = readFileSync(join(f.root, "state.json"), "utf8");
    f.config.profiles.both.hooks = ["fixture:second"];
    f.saveConfig();
    chmodSync(dirname(claudePath), 0o500);
    try {
      assertWriteFailure(() => f.run("apply", "both", "--yes"), /claude\/settings\.json\.\d+\.tmp/);
    } finally {
      chmodSync(dirname(claudePath), 0o700);
    }
    assert.equal(readFileSync(entry.target, "utf8"), codexBefore);
    assert.equal(readFileSync(claudePath, "utf8"), claudeBefore);
    assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), stateBefore);
    assert.equal(lstatSync(entry.target).isSymbolicLink(), representation === "symlink");
    if (representation === "symlink") assert.equal(readlinkSync(entry.target), link);
    for (const harness of ["codex", "claude"]) {
      assert.equal(lstatSync(join(f.root, harness, "managed-hooks", "fixture", "first")).isSymbolicLink(), true);
      assert.equal(existsSync(join(f.root, harness, "managed-hooks", "fixture", "second")), false);
    }
  });
}

test("state保存失敗で今回新規作成したCodex hooks.jsonと管理linkを取り除く", (t) => {
  const f = fixture(t);
  f.config.profiles.codex.hooks = ["fixture:first"];
  f.saveConfig();
  f.run("apply", "codex", "--yes");
  f.run("rollback", "--yes");
  const path = hookPath(f.root, "codex");
  rmSync(path);
  const stateBefore = readFileSync(join(f.root, "state.json"), "utf8");
  chmodSync(f.root, 0o500);
  try {
    assertWriteFailure(() => f.run("apply", "codex", "--yes"), /state\.json\.\d+\.tmp/);
  } finally {
    chmodSync(f.root, 0o700);
  }
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(f.root, "codex", "skills", "sample")), false);
  assert.equal(existsSync(join(f.root, "codex", "managed-hooks", "fixture", "first")), false);
  assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), stateBefore);
});

for (const harness of ["codex", "claude"] as const) {
  for (const invalid of ["symlink", "directory", "invalid-json", "invalid-hooks", "unowned-group"] as const) {
    test(`${harness}のhook設定が${invalid}なら安全に停止して既存内容を保持する`, (t) => {
      const f = fixture(t);
      f.config.profiles[harness].hooks = ["fixture:first"];
      f.saveConfig();
      const path = hookPath(f.root, harness);
      mkdirSync(dirname(path), { recursive: true });
      const otherPath = join(f.root, "user.json");
      writeFileSync(otherPath, "{}");
      if (invalid === "symlink") symlinkSync(otherPath, path);
      else if (invalid === "directory") mkdirSync(path);
      else if (invalid === "invalid-json") writeFileSync(path, "invalid");
      else if (invalid === "invalid-hooks") writeFileSync(path, '{"hooks":[]}');
      else writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", ...userGroup("echo managed-first") }] } }));
      const before = invalid === "directory" ? null : readFileSync(path, "utf8");
      for (const command of ["plan", "apply"]) {
        assert.throws(() => f.run(command, harness, "--yes"), /管理外symlink|通常file|読み込めません|hooksはobject|安全に区別できません/);
      }
      assert.equal(invalid === "directory" ? null : readFileSync(path, "utf8"), before);
      assert.equal(readFileSync(otherPath, "utf8"), "{}");
      assert.equal(existsSync(join(f.root, "state.json")), false);
      assert.equal(existsSync(join(f.root, harness, "skills", "sample")), false);
    });
  }
}

test("旧Codex管理symlinkの参照先が変わっていればdriftとして拒否する", (t) => {
  const f = fixture(t);
  const { entry, artifact } = legacyCodex(f);
  const other = join(f.root, "unmanaged.json");
  writeFileSync(other, artifact);
  rmSync(entry.target);
  symlinkSync(other, entry.target);
  assert.match(f.run("status"), /drifted\thook-config/);
  assert.throws(() => f.run("apply", "codex", "--yes"), /管理外symlink/);
  assert.equal(readlinkSync(entry.target), other);
  assert.equal(readFileSync(other, "utf8"), artifact);
});
