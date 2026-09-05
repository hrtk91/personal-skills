import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

function runCli(args: string[], root: string): string {
  return execFileSync(process.execPath, [
    "--experimental-strip-types",
    cli,
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PERSONAL_SKILLS_CONFIG: join(root, "profiles.json"),
      PERSONAL_SKILLS_STATE: join(root, "state.json"),
      PERSONAL_SKILLS_TARGET: join(root, "target"),
      PERSONAL_SKILLS_CODEX_HOME: join(root, "codex"),
    },
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
        sample: { skills: ["review"] },
        empty: { skills: [] },
      },
    }));
    mkdirSync(join(root, "target", ".system"), { recursive: true });
    writeFileSync(join(root, "target", ".system", "marker"), "keep");

    const concise = runCli(["skills"], root);
    assert.match(concise, /^personal \(\d+\)$/m);
    assert.match(concise, /  review/);
    assert.doesNotMatch(concise, /\/skills\/review/);
    assert.match(
      runCli(["skills", "--verbose"], root),
      /personal:review\t.*\/skills\/review/,
    );

    const plan = runCli(["plan", "sample"], root);
    assert.match(plan, /\+ link追加 skill personal:review/);

    runCli(["apply", "sample", "--yes"], root);
    const target = join(root, "target", "review");
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review"));
    assert.equal(readFileSync(join(root, "target", ".system", "marker"), "utf8"), "keep");
    assert.match(runCli(["status"], root), /有効なprofile: sample/);

    runCli(["apply", "empty", "--yes"], root);
    assert.equal(readFileSync(join(root, "state.json"), "utf8").includes('"empty"'), true);
    assert.throws(() => realpathSync(target));

    runCli(["rollback", "--yes"], root);
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review"));
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
    mkdirSync(join(extraSkills, "review"), { recursive: true });
    writeFileSync(join(extraSkills, "company-review", "SKILL.md"), [
      "---",
      "name: company-review",
      "description: Work review skill",
      "---",
      "",
    ].join("\n"));
    writeFileSync(join(extraSkills, "review", "SKILL.md"), [
      "---",
      "name: review",
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
      multi: { skills: ["personal:review", "work:company-review"] },
      collision: { skills: ["personal:review", "work:review"] },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const plan = runCli(["plan", "multi"], root);
    assert.match(plan, /\+ link追加 skill personal:review/);
    assert.match(plan, /\+ link追加 skill work:company-review/);

    runCli(["apply", "multi", "--yes"], root);
    assert.equal(
      realpathSync(join(root, "target", "review")),
      join(repoRoot, "skills", "review"),
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
          skills: ["review"],
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

test("automatically persists legacy config as v4 and legacy state as v3", () => {
  const root = mkdtempSync(join(tmpdir(), "personal-skills-ctl-migration-test-"));
  try {
    const configPath = join(root, "profiles.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      profiles: {
        legacy: {
          description: "legacy profile",
          skills: ["review", "review"],
        },
      },
    }));
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      targetDir: join(root, "target"),
      activeProfile: "legacy",
      managed: [{
        ref: "review",
        source: join(repoRoot, "skills", "review"),
        target: join(root, "target", "review"),
      }],
      history: [],
    }));

    runCli(["profile", "show", "legacy"], root);
    runCli(["status"], root);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.version, 4);
    assert.equal(config.sources.personal.path, repoRoot);
    assert.deepEqual(config.profiles.legacy, {
      description: "legacy profile",
      skills: ["personal:review"],
      rules: [],
      hooks: [],
    });

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.version, 3);
    assert.equal(state.codexHome, join(root, "codex"));
    assert.deepEqual(state.managed[0], {
      kind: "skill",
      linkType: "dir",
      ref: "personal:review",
      sourceId: "personal",
      name: "review",
      source: join(repoRoot, "skills", "review"),
      target: join(root, "target", "review"),
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
    assert.equal(config.version, 4);
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
        selected: { skills: ["personal:review"] },
        empty: { skills: [] },
      },
    }));
    runCli(["apply", "selected", "--yes"], root);
    const target = join(root, "target", "review");
    assert.equal(realpathSync(target), join(repoRoot, "skills", "review"));

    chmodSync(root, 0o500);
    assert.throws(() => runCli(["apply", "empty", "--yes"], root), /read-only|permission|EACCES/i);
    chmodSync(root, 0o700);

    assert.equal(realpathSync(target), join(repoRoot, "skills", "review"));
    assert.match(runCli(["status"], root), /有効なprofile: selected/);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
