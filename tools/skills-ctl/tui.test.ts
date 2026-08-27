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
import { profileTui, runMultiPicker, type PromptFunctions } from "./tui.ts";

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

function scriptedPrompts(
  results: unknown[],
  cancelValue = Symbol("cancel"),
  receivedOptions: unknown[] = [],
): PromptFunctions {
  const next = async (promptOptions: unknown) => {
    receivedOptions.push(promptOptions);
    return results.shift();
  };
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

test("既存profileを編集すると現在のskill・rules・hookが選択済みで表示される", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-existing-test-"));
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
    const receivedOptions: unknown[] = [];

    await profileTui("safe", cliOptions, scriptedPrompts([
      ["fixture:sample-skill"],
      "fixture:sample-policy",
      ["fixture:sample-policy"],
    ], undefined, receivedOptions));

    assert.deepEqual(
      (receivedOptions[0] as { initialValues?: string[] }).initialValues,
      ["fixture:sample-skill"],
    );
    assert.equal(
      (receivedOptions[1] as { initialValue?: string }).initialValue,
      "fixture:sample-policy",
    );
    assert.deepEqual(
      (receivedOptions[2] as { initialValues?: string[] }).initialValues,
      ["fixture:sample-policy"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const multiplePickerItems = [
  { ref: "fixture:first", description: "first", source: "/fixture/first" },
  { ref: "fixture:second", description: "second", source: "/fixture/second" },
  { ref: "fixture:third", description: "third", source: "/fixture/third" },
];

test("既存の複数選択は先頭の選択項目から移動を開始する", async () => {
  const receivedOptions: unknown[] = [];

  await runMultiPicker(
    multiplePickerItems,
    "fixture",
    ["fixture:first", "fixture:third"],
    scriptedPrompts([
      ["fixture:third", "fixture:first"],
    ], undefined, receivedOptions),
  );

  assert.deepEqual(
    (receivedOptions[0] as { initialValues?: string[] }).initialValues,
    ["fixture:third", "fixture:first"],
  );
});

test("初期focusを調整しても既存選択と追加項目の保存順を維持する", async () => {
  const selected = await runMultiPicker(
    multiplePickerItems,
    "fixture",
    ["fixture:first", "fixture:third"],
    scriptedPrompts([
      ["fixture:third", "fixture:first", "fixture:second"],
    ]),
  );

  assert.deepEqual(selected, ["fixture:first", "fixture:third", "fixture:second"]);
});

test("skill候補は長い説明文を行へ表示せず8件以内で検索できる", async () => {
  const receivedOptions: unknown[] = [];
  await runMultiPicker([{
    ref: "fixture:sample-skill",
    description: "needleを含む長い説明文".repeat(20),
    source: "/fixture/source",
  }], "profileに含めるskill", [], scriptedPrompts([
    [],
  ], undefined, receivedOptions));

  const promptOptions = receivedOptions[0] as {
    maxItems?: number;
    options: Array<{ hint?: string; searchText?: string }>;
    filter?: (search: string, option: { hint?: string; searchText?: string }) => boolean;
  };
  const option = promptOptions.options[0];
  assert.equal(promptOptions.maxItems, 8);
  assert.equal(option.hint, undefined);
  assert.equal(promptOptions.filter?.("needle", option), true);
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
