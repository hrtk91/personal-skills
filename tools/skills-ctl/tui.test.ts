import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Options } from "./model.ts";
import { profileTui, type PromptFunctions } from "./tui.ts";

function createResourceSource(root: string): string {
  const source = join(root, "resources");
  mkdirSync(join(source, "skills", "sample-skill"), { recursive: true });
  mkdirSync(join(source, "rules", "sample-policy"), { recursive: true });
  mkdirSync(join(source, "hooks", "sample-policy"), { recursive: true });
  writeFileSync(join(source, "skills", "sample-skill", "SKILL.md"), [
    "---",
    "name: sample-skill",
    "description: fixture skill",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(source, "rules", "sample-policy", "AGENTS.md"), "# fixture\n");
  writeFileSync(join(source, "hooks", "sample-policy", "hooks.json"), "{\"hooks\":{}}\n");
  return source;
}

function options(root: string): Options {
  const codexHome = join(root, "codex");
  return {
    configPath: join(root, "profiles.json"),
    statePath: join(root, "state.json"),
    codexHome,
    targetDir: join(codexHome, "skills"),
    sourceId: undefined,
    verbose: false,
    yes: false,
    dryRun: false,
  };
}

function scriptedPrompts(results: unknown[], cancelValue = Symbol("cancel")): PromptFunctions {
  const next = async () => results.shift();
  return {
    autocomplete: next,
    autocompleteMultiselect: next,
    text: next,
    isCancel: (value) => value === cancelValue,
  };
}

test("npm dependencyのpromptで選んだskill・rules・hookをprofileへ保存する", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-test-"));
  try {
    const source = createResourceSource(root);
    const cliOptions = options(root);
    writeFileSync(cliOptions.configPath, JSON.stringify({
      version: 3,
      sources: { fixture: { path: source } },
      profiles: {},
    }));

    await profileTui("safe", cliOptions, scriptedPrompts([
      ["fixture:sample-skill"],
      "fixture:sample-policy",
      ["fixture:sample-policy"],
    ]));

    const config = JSON.parse(readFileSync(cliOptions.configPath, "utf8"));
    assert.deepEqual(config.profiles.safe, {
      description: "skillsctlで作成",
      skills: ["fixture:sample-skill"],
      rules: "fixture:sample-policy",
      hooks: ["fixture:sample-policy"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promptを途中で中止するとprofile設定を変更しない", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-cancel-test-"));
  try {
    const source = createResourceSource(root);
    const cliOptions = options(root);
    const original = JSON.stringify({
      version: 3,
      sources: { fixture: { path: source } },
      profiles: {},
    });
    writeFileSync(cliOptions.configPath, original);
    const cancelValue = Symbol("cancel");

    await profileTui("safe", cliOptions, scriptedPrompts([
      ["fixture:sample-skill"],
      cancelValue,
    ], cancelValue));

    assert.equal(readFileSync(cliOptions.configPath, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("なしを選ぶと既存のrulesを解除できる", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-clear-test-"));
  try {
    const source = createResourceSource(root);
    const cliOptions = options(root);
    writeFileSync(cliOptions.configPath, JSON.stringify({
      version: 3,
      sources: { fixture: { path: source } },
      profiles: {
        safe: {
          skills: ["fixture:sample-skill"],
          rules: "fixture:sample-policy",
          hooks: ["fixture:sample-policy"],
        },
      },
    }));

    await profileTui("safe", cliOptions, scriptedPrompts([
      ["fixture:sample-skill"],
      "",
      [],
    ]));

    const config = JSON.parse(readFileSync(cliOptions.configPath, "utf8"));
    assert.equal(config.profiles.safe.rules, null);
    assert.deepEqual(config.profiles.safe.hooks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
