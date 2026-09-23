import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "tools", "skills-ctl.ts");

function runCli(args: string[], root: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERSONAL_SKILLS_CONFIG: join(root, "profiles.json"),
    PERSONAL_SKILLS_STATE: join(root, "state.json"),
    PERSONAL_SKILLS_TARGET: join(root, "target"),
    PERSONAL_SKILLS_CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    ...extraEnv,
  };
  delete env.PERSONAL_SKILLS_CLAUDE_HOME;
  return execFileSync(process.execPath, [
    "--experimental-strip-types",
    cli,
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createManagedResourceSource(root: string): string {
  const source = join(root, "managed-resource-source");
  mkdirSync(join(source, "rules", "review-policy"), { recursive: true });
  mkdirSync(join(source, "rules", "release-policy"), { recursive: true });
  mkdirSync(join(source, "rules", "方針共有ルール"), { recursive: true });
  mkdirSync(join(source, "hooks", "review-policy"), { recursive: true });
  writeFileSync(
    join(source, "rules", "review-policy", "AGENTS.md"),
    "# テスト用常時ルール\n",
  );
  writeFileSync(
    join(source, "rules", "release-policy", "AGENTS.md"),
    "# テスト用リリースルール\n",
  );
  writeFileSync(
    join(source, "rules", "方針共有ルール", "AGENTS.md"),
    "# 日本語名の常時ルール\n",
  );
  writeFileSync(join(source, "hooks", "review-policy", "noop.mjs"), "process.exit(0);\n");
  writeFileSync(join(source, "hooks", "review-policy", "hooks.json"), JSON.stringify({
    targets: ["codex", "claude"],
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "node {{HOOK_ROOT}}/noop.mjs" }],
      }],
    },
  }));
  return source;
}

test("plan, apply, status, and rollback only manage selected symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-test-"));
  try {
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 1,
      profiles: {
        sample: { skills: ["review-maintainability"] },
        empty: { skills: [] },
      },
    }));
    mkdirSync(join(root, "target", ".system"), { recursive: true });
    writeFileSync(join(root, "target", ".system", "marker"), "keep");

    const concise = runCli(["skills"], root);
    assert.match(concise, /^personal \(\d+\)$/m);
    assert.match(concise, /  review-maintainability/);
    assert.doesNotMatch(concise, /\/skills\/review-maintainability/);
    assert.match(
      runCli(["skills", "--verbose"], root),
      /personal:review-maintainability\t.*\/skills\/review-maintainability/,
    );

    const plan = runCli(["plan", "sample"], root);
    assert.match(plan, /\+ link追加 skill personal:review-maintainability/);

    runCli(["apply", "sample", "--yes"], root);
    const target = join(root, "target", "review-maintainability");
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review-maintainability"));
    assert.equal(readFileSync(join(root, "target", ".system", "marker"), "utf8"), "keep");
    assert.match(runCli(["status"], root), /有効なprofile: sample/);

    runCli(["apply", "empty", "--yes"], root);
    assert.equal(readFileSync(join(root, "state.json"), "utf8").includes('"empty"'), true);
    assert.throws(() => realpathSync(target));

    runCli(["rollback", "--yes"], root);
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review-maintainability"));
    assert.match(runCli(["status"], root), /有効なprofile: sample/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers a source and applies namespaced skills", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-sources-test-"));
  try {
    const extraRepo = join(root, "work-skills-repo");
    const extraSkills = join(extraRepo, "skills");
    mkdirSync(join(extraSkills, "company-review"), { recursive: true });
    mkdirSync(join(extraSkills, "review-maintainability"), { recursive: true });
    writeFileSync(join(extraSkills, "company-review", "SKILL.md"), [
      "---",
      "name: company-review",
      "description: Work review skill",
      "---",
      "",
    ].join("\n"));
    writeFileSync(join(extraSkills, "review-maintainability", "SKILL.md"), [
      "---",
      "name: review-maintainability",
      "description: Another review skill",
      "---",
      "",
    ].join("\n"));

    assert.match(
      runCli(["sources", "add", extraRepo, "--id", "work"], root),
      /sourceを追加しました: work/,
    );
    assert.match(runCli(["sources", "list"], root), /work\t.*skill 2件/);

    const configPath = join(root, "profiles.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profiles: Record<string, { skills: string[] }>;
    };
    config.profiles = {
      multi: { skills: ["personal:review-maintainability", "work:company-review"] },
      collision: { skills: ["personal:review-maintainability", "work:review-maintainability"] },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const plan = runCli(["plan", "multi"], root);
    assert.match(plan, /\+ link追加 skill personal:review-maintainability/);
    assert.match(plan, /\+ link追加 skill work:company-review/);

    runCli(["apply", "multi", "--yes"], root);
    assert.equal(
      realpathSync(join(root, "target", "review-maintainability")),
      join(repoRoot, "skills", "review-maintainability"),
    );
    assert.equal(
      realpathSync(join(root, "target", "company-review")),
      join(extraSkills, "company-review"),
    );

    assert.throws(
      () => runCli(["plan", "collision"], root),
      /導入先が衝突しています/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile generates AGENTS.override.md from base AGENTS.md and multiple rules", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-resources-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: {
          skills: ["review-maintainability"],
          rules: ["fixture:review-policy", "fixture:release-policy"],
          hooks: ["fixture:review-policy"],
        },
        empty: { skills: [] },
      },
    }));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "# テスト用base\n");

    const plan = runCli(["plan", "guarded"], root);
    assert.match(plan, /link追加 rules generated:[a-f0-9]{64}/);
    assert.match(plan, /link追加 hook-package fixture:review-policy/);
    assert.match(plan, /link追加 hook-config generated:/);
    assert.throws(() => realpathSync(join(root, "artifacts")));

    runCli(["apply", "guarded", "--yes"], root);
    const agentsPath = realpathSync(join(codexHome, "AGENTS.override.md"));
    assert.match(agentsPath, /artifacts\/agents-[a-f0-9]{64}\.md$/);
    assert.equal(lstatSync(join(codexHome, "AGENTS.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(codexHome, "AGENTS.md"), "utf8"), "# テスト用base\n");
    const agents = readFileSync(join(codexHome, "AGENTS.override.md"), "utf8");
    assert.match(agents, /harnessctlが生成しました/);
    assert.ok(
      agents.indexOf("# テスト用base") < agents.indexOf("# テスト用常時ルール"),
    );
    assert.ok(
      agents.indexOf("# テスト用常時ルール") < agents.indexOf("# テスト用リリースルール"),
    );
    assert.equal(
      realpathSync(join(codexHome, "managed-hooks", "fixture", "review-policy")),
      join(resourceSource, "hooks", "review-policy"),
    );
    const generatedHooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.match(
      generatedHooks.hooks.PreToolUse[0].hooks[0].command,
      /managed-hooks\/fixture\/review-policy.*noop\.mjs/,
    );
    assert.equal(execFileSync("bash", ["-lc", generatedHooks.hooks.PreToolUse[0].hooks[0].command], {
      cwd: root,
      input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command: "git status" } }),
      encoding: "utf8",
    }), "");
    assert.match(runCli(["status"], root), /ok\trules\tgenerated:[a-f0-9]{64}/);

    runCli(["apply", "empty", "--yes"], root);
    assert.throws(() => realpathSync(join(codexHome, "AGENTS.override.md")));
    assert.equal(readFileSync(join(codexHome, "AGENTS.md"), "utf8"), "# テスト用base\n");
    assert.throws(() => realpathSync(join(codexHome, "hooks.json")));

    runCli(["rollback", "--yes"], root);
    assert.equal(realpathSync(join(codexHome, "AGENTS.override.md")), agentsPath);
    assert.equal(readFileSync(join(codexHome, "AGENTS.override.md"), "utf8"), agents);
    assert.match(runCli(["status"], root), /有効なprofile: guarded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("日本語のrules directory name can be selected and applied", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-japanese-rule-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: {
          skills: [],
          rules: ["fixture:方針共有ルール"],
          hooks: [],
        },
      },
    }));

    runCli(["apply", "guarded", "--yes"], root);

    assert.match(
      readFileSync(join(root, "codex", "AGENTS.override.md"), "utf8"),
      /# 日本語名の常時ルール/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows a user-owned AGENTS.md and refuses an unmanaged override or hooks file", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-conflict-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: {
          skills: [],
          rules: ["fixture:review-policy"],
          hooks: ["fixture:review-policy"],
        },
      },
    }));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "user owned\n");
    assert.match(runCli(["plan", "guarded"], root), /link追加 rules generated:/);

    writeFileSync(join(codexHome, "AGENTS.override.md"), "override\n");
    assert.throws(() => runCli(["plan", "guarded"], root), /既存の通常fileまたはdirectoryが導入を妨げています/);
    rmSync(join(codexHome, "AGENTS.override.md"));

    writeFileSync(join(codexHome, "hooks.json"), "{}\n");
    assert.throws(() => runCli(["plan", "guarded"], root), /既存の通常fileまたはdirectoryが導入を妨げています/);
    assert.equal(readFileSync(join(codexHome, "AGENTS.md"), "utf8"), "user owned\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detaches the legacy AGENTS.md rules entry after the base becomes user-owned", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-legacy-rules-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "base from override\n");
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: {
          skills: [],
          rules: ["fixture:review-policy"],
          hooks: [],
        },
      },
    }));
    writeFileSync(join(root, "state.json"), JSON.stringify({
      version: 3,
      codexHome,
      targetDir: join(codexHome, "skills"),
      activeProfile: "guarded",
      managed: [{
        kind: "rules",
        linkType: "file",
        ref: "generated:legacy",
        sourceId: "generated",
        name: "legacy",
        source: join(root, "legacy-agents.md"),
        target: join(codexHome, "AGENTS.md"),
      }],
      history: [],
    }));

    runCli(["apply", "guarded", "--yes"], root);

    assert.equal(lstatSync(join(codexHome, "AGENTS.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(codexHome, "AGENTS.md"), "utf8"), "base from override\n");
    assert.equal(lstatSync(join(codexHome, "AGENTS.override.md")).isSymbolicLink(), true);
    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      managed: Array<{ kind: string; target: string }>;
      history: Array<{ managed: Array<{ target: string }> }>;
    };
    assert.ok(state.managed.every((entry) => entry.target !== join(codexHome, "AGENTS.md")));
    assert.ok(state.history.every((backup) => backup.managed.every(
      (entry) => entry.target !== join(codexHome, "AGENTS.md"),
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects config versions newer than the CLI understands", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-version-test-"));
  try {
    writeFileSync(join(root, "profiles.json"), JSON.stringify({ version: 99, profiles: {} }));
    assert.throws(() => runCli(["profile", "list"], root), /未対応のconfig versionです: 99/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatically persists legacy config as v5 and legacy state as v4", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-migration-test-"));
  try {
    const configPath = join(root, "profiles.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      profiles: {
        legacy: {
          description: "legacy profile",
          skills: ["review-maintainability", "review-maintainability"],
        },
      },
    }));
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      targetDir: join(root, "target"),
      activeProfile: "legacy",
      managed: [{
        ref: "review-maintainability",
        source: join(repoRoot, "skills", "review-maintainability"),
        target: join(root, "target", "review-maintainability"),
      }],
      history: [],
    }));

    runCli(["profile", "show", "legacy"], root);
    runCli(["status"], root);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.version, 5);
    assert.equal(config.sources.personal.path, repoRoot);
    assert.deepEqual(config.profiles.legacy, {
      description: "legacy profile",
      targets: ["codex"],
      skills: ["personal:review-maintainability"],
      rules: [],
      hooks: [],
    });

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.version, 4);
    assert.equal(state.codexHome, join(root, "codex"));
    assert.equal(state.claudeHome, join(root, "claude"));
    assert.deepEqual(state.targets, ["codex"]);
    assert.deepEqual(state.managed[0], {
      harness: "codex",
      kind: "skill",
      linkType: "dir",
      ref: "personal:review-maintainability",
      sourceId: "personal",
      name: "review-maintainability",
      source: join(repoRoot, "skills", "review-maintainability"),
      target: join(root, "target", "review-maintainability"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates a v3 profile with one rule to the ordered rules array", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-rules-migration-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    const configPath = join(root, "profiles.json");
    writeFileSync(configPath, JSON.stringify({
      version: 3,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: {
          skills: [],
          rules: "fixture:review-policy",
          hooks: [],
        },
      },
    }));

    runCli(["profile", "show", "guarded"], root);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.version, 5);
    assert.deepEqual(config.profiles.guarded.rules, ["fixture:review-policy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merges multiple selected hook packages in profile order", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-hook-merge-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    const extraRepo = join(root, "extra");
    mkdirSync(join(extraRepo, "hooks", "session-note"), { recursive: true });
    writeFileSync(join(extraRepo, "hooks", "session-note", "note.mjs"), "process.exit(0);\n");
    writeFileSync(join(extraRepo, "hooks", "session-note", "hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node {{HOOK_ROOT}}/note.mjs" }] }],
      },
    }));
    runCli(["sources", "add", resourceSource, "--id", "fixture"], root);
    runCli(["sources", "add", extraRepo, "--id", "extra"], root);
    const configPath = join(root, "profiles.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    config.profiles = {
      merged: {
        skills: [],
        hooks: ["fixture:review-policy", "extra:session-note"],
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    runCli(["apply", "merged", "--yes"], root);
    const generated = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(generated.hooks.PreToolUse.length, 1);
    assert.equal(generated.hooks.SessionStart.length, 1);
    assert.match(JSON.stringify(generated.hooks.SessionStart), /managed-hooks.*extra.*session-note.*note\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports and refuses a managed hooks file replaced by another installer", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-hook-drift-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        guarded: { skills: [], hooks: ["fixture:review-policy"] },
      },
    }));
    runCli(["apply", "guarded", "--yes"], root);
    const hooksPath = join(root, "codex", "hooks.json");
    rmSync(hooksPath);
    writeFileSync(hooksPath, "{\"hooks\":{}}\n");

    assert.match(runCli(["status"], root), /drifted\thook-config/);
    assert.throws(
      () => runCli(["apply", "guarded", "--yes"], root),
      /既存の通常fileまたはdirectoryが導入を妨げています/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores the previous links when the atomic state write fails", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-state-failure-test-"));
  try {
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 4,
      profiles: {
        selected: { skills: ["personal:review-maintainability"] },
        empty: { skills: [] },
      },
    }));
    runCli(["apply", "selected", "--yes"], root);
    const target = join(root, "target", "review-maintainability");
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review-maintainability"));

    chmodSync(root, 0o500);
    assert.throws(() => runCli(["apply", "empty", "--yes"], root), /read-only|permission|EACCES/i);
    chmodSync(root, 0o700);

    assert.equal(realpathSync(target), join(repoRoot, "skills", "review-maintainability"));
    assert.match(runCli(["status"], root), /有効なprofile: selected/);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude targetは既存CLAUDE.mdとsettingsの他hook・他keyを保ったままresourceを導入する", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-claude-apply-test-"));
  try {
    const resourceSource = createManagedResourceSource(root);
    const claudeHome = join(root, "claude");
    mkdirSync(claudeHome, { recursive: true });
    const claudeMemory = "# ユーザー所有の記憶\nこの内容を保持する。\n";
    writeFileSync(join(claudeHome, "CLAUDE.md"), claudeMemory);
    const userHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo user-owned" }],
    };
    const settings = {
      model: "claude-sonnet-4-5",
      theme: "dark",
      statusLine: { type: "command", command: "printf user-status" },
      hooks: { PreToolUse: [userHook] },
    };
    writeFileSync(join(claudeHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 5,
      sources: { fixture: { path: resourceSource } },
      profiles: {
        claude: {
          targets: ["codex", "claude"],
          skills: ["personal:review-maintainability"],
          rules: ["fixture:review-policy"],
          hooks: ["personal:single-review-decision"],
        },
      },
    }));

    const plan = runCli(["plan", "claude"], root);
    assert.match(plan, /対象ハーネス: codex, claude/);
    assert.match(plan, /link追加 skill personal:review-maintainability \[codex\]/);
    assert.match(plan, /hook追加 claude-hook-config generated:/);
    runCli(["apply", "claude", "--yes"], root);

    assert.equal(realpathSync(join(claudeHome, "skills", "review-maintainability")), join(repoRoot, "skills", "review-maintainability"));
    assert.equal(realpathSync(join(root, "target", "review-maintainability")), join(repoRoot, "skills", "review-maintainability"));
    assert.equal(lstatSync(join(claudeHome, "rules", "harnessctl-personal-skills.md")).isSymbolicLink(), true);
    assert.match(readFileSync(join(claudeHome, "rules", "harnessctl-personal-skills.md"), "utf8"), /# テスト用常時ルール/);
    assert.equal(readFileSync(join(claudeHome, "CLAUDE.md"), "utf8"), claudeMemory);

    const installedSettings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as {
      model: string;
      theme: string;
      statusLine: unknown;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    assert.equal(installedSettings.model, settings.model);
    assert.equal(installedSettings.theme, settings.theme);
    assert.deepEqual(installedSettings.statusLine, settings.statusLine);
    assert.deepEqual(installedSettings.hooks.PreToolUse[0], userHook);
    assert.equal(installedSettings.hooks.PreToolUse.length, 2);
    const claudeHook = installedSettings.hooks.PreToolUse[1];
    assert.equal(claudeHook.matcher, "Bash");
    assert.match(claudeHook.hooks[0].command, /managed-hooks\/personal\/single-review-decision/);
    assert.doesNotMatch(claudeHook.hooks[0].command, /\{\{HOOK_ROOT\}\}/);

    const bodyPath = join(root, "pr-body.md");
    writeFileSync(bodyPath, "## レビュワーに求める判断\nこのPRを承認してよいかを判断する。\n");
    const hookOutput = execFileSync("bash", ["-lc", claudeHook.hooks[0].command], {
      cwd: root,
      input: JSON.stringify({
        tool_name: "Bash",
        cwd: root,
        tool_input: { command: `gh pr create --body-file ${bodyPath}` },
      }),
      encoding: "utf8",
    });
    assert.equal(hookOutput, "");
    assert.match(runCli(["status"], root), /ok\tclaude-hook-config\tgenerated:/);
    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      claudeHome: string;
      managed: Array<{ harness: string }>;
    };
    assert.equal(state.claudeHome, claudeHome);
    assert.deepEqual([...new Set(state.managed.map((entry) => entry.harness))], ["codex", "claude"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude profileのrollbackは後から変わったsettings keyと管理外hookを保持する", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-claude-rollback-test-"));
  try {
    const claudeHome = join(root, "claude");
    mkdirSync(claudeHome, { recursive: true });
    const initialUserHook = { hooks: [{ type: "command", command: "echo before" }] };
    writeFileSync(join(claudeHome, "settings.json"), `${JSON.stringify({
      model: "claude-sonnet-4-5",
      theme: "dark",
      statusLine: { type: "command", command: "printf before" },
      hooks: { PreToolUse: [initialUserHook] },
    }, null, 2)}\n`);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 5,
      profiles: {
        claude: {
          targets: ["claude"],
          skills: [],
          rules: [],
          hooks: ["personal:single-review-decision"],
        },
        emptyClaude: { targets: ["claude"], skills: [], rules: [], hooks: [] },
      },
    }));

    runCli(["apply", "claude", "--yes"], root);
    const settingsPath = join(claudeHome, "settings.json");
    const editedByUser = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown> & {
      hooks: Record<string, unknown[]>;
    };
    editedByUser.theme = "light-after-install";
    editedByUser.statusLine = { type: "command", command: "printf after" };
    editedByUser.editorMode = "vim";
    const laterUserHook = { matcher: "Write", hooks: [{ type: "command", command: "echo later" }] };
    editedByUser.hooks.PreToolUse.push(laterUserHook);
    writeFileSync(settingsPath, `${JSON.stringify(editedByUser, null, 2)}\n`);

    runCli(["apply", "emptyClaude", "--yes"], root);
    let settings = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof editedByUser;
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.deepEqual(settings.hooks.PreToolUse, [initialUserHook, laterUserHook]);

    runCli(["rollback", "--yes"], root);
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof editedByUser;
    assert.equal(settings.model, "claude-sonnet-4-5");
    assert.equal(settings.theme, "light-after-install");
    assert.deepEqual(settings.statusLine, { type: "command", command: "printf after" });
    assert.equal(settings.editorMode, "vim");
    assert.equal(settings.hooks.PreToolUse.length, 3);
    assert.deepEqual(settings.hooks.PreToolUse[0], initialUserHook);
    assert.deepEqual(settings.hooks.PreToolUse[1], laterUserHook);
    assert.match(JSON.stringify(settings.hooks.PreToolUse[2]), /single-review-decision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude設定で管理hookと同じgroupが重複したらdriftを示し、削除しない", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-claude-hook-duplicate-test-"));
  try {
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 5,
      profiles: {
        claude: {
          targets: ["claude"],
          skills: [],
          rules: [],
          hooks: ["personal:single-review-decision"],
        },
      },
    }));
    runCli(["apply", "claude", "--yes"], root);

    const settingsPath = join(root, "claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: unknown[] };
    };
    settings.hooks.PreToolUse.push(structuredClone(settings.hooks.PreToolUse[0]));
    const duplicatedSettings = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(settingsPath, duplicatedSettings);

    assert.match(runCli(["status"], root), /drifted\tclaude-hook-config/);
    assert.throws(() => runCli(["apply", "claude", "--yes"], root));
    assert.equal(readFileSync(settingsPath, "utf8"), duplicatedSettings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state保存失敗時はClaude settingsと管理symlinkを直前の状態へ戻す", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-claude-state-failure-test-"));
  const stateDirectory = join(root, "state-store");
  mkdirSync(stateDirectory);
  const statePath = join(stateDirectory, "state.json");
  const cliEnv = { PERSONAL_SKILLS_STATE: statePath };
  try {
    const claudeHome = join(root, "claude");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), `${JSON.stringify({
      theme: "dark",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
    }, null, 2)}\n`);
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 5,
      profiles: {
        claude: {
          targets: ["claude"],
          skills: ["personal:review-maintainability"],
          rules: [],
          hooks: ["personal:single-review-decision"],
        },
        emptyClaude: { targets: ["claude"], skills: [], rules: [], hooks: [] },
      },
    }));
    runCli(["apply", "claude", "--yes"], root, cliEnv);
    const settingsPath = join(claudeHome, "settings.json");
    const beforeFailedApply = readFileSync(settingsPath, "utf8");

    chmodSync(stateDirectory, 0o500);
    assert.throws(() => runCli(["apply", "emptyClaude", "--yes"], root, cliEnv));
    chmodSync(stateDirectory, 0o700);

    assert.equal(readFileSync(settingsPath, "utf8"), beforeFailedApply);
    assert.equal(realpathSync(join(claudeHome, "skills", "review-maintainability")), join(repoRoot, "skills", "review-maintainability"));
    assert.match(runCli(["status"], root, cliEnv), /有効なprofile: claude/);
    assert.match(runCli(["status"], root, cliEnv), /ok\tclaude-hook-config/);
  } finally {
    chmodSync(stateDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex専用hookをClaude profileで適用せずplanに対象外理由を表示する", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-claude-excluded-hook-test-"));
  try {
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 5,
      profiles: {
        claudeOnly: {
          targets: ["claude"],
          skills: [],
          rules: [],
          hooks: ["personal:subagent-model-notice-for-openai"],
        },
      },
    }));

    const plan = runCli(["plan", "claudeOnly"], root);
    assert.match(plan, /Claude対象外 hook personal:subagent-model-notice-for-openai/);
    assert.match(plan, /対応対象はcodexです/);
    runCli(["apply", "claudeOnly", "--yes"], root);
    assert.equal(existsSync(join(root, "claude", "settings.json")), false);
    assert.match(runCli(["status"], root), /有効なprofile: claudeOnly/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
