import { strict as assert } from "node:assert";
import {
  existsSync,
  lstatSync,
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
    confirm: next,
    text: next,
    isCancel: (value) => value === cancelValue,
  };
}

test("選んだresourceをprofileへ保存し、保存のみでは導入状態を変更しない", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-test-"));
  try {
    const source = createResourceSource(root);
    const cliOptions = options(root);
    const receivedOptions: unknown[] = [];
    writeFileSync(cliOptions.configPath, JSON.stringify({
      version: 3,
      sources: { fixture: { path: source } },
      profiles: {},
    }));

    await profileTui("safe", cliOptions, scriptedPrompts([
      ["fixture:sample-skill"],
      "fixture:sample-policy",
      ["fixture:sample-policy"],
      false,
    ], undefined, receivedOptions));

    const config = JSON.parse(readFileSync(cliOptions.configPath, "utf8"));
    assert.deepEqual(config.profiles.safe, {
      description: "harnessctlで作成",
      skills: ["fixture:sample-skill"],
      rules: "fixture:sample-policy",
      hooks: ["fixture:sample-policy"],
    });
    assert.equal(existsSync(cliOptions.statePath), false);
    assert.deepEqual(receivedOptions[3], {
      message: "保存したprofileを今すぐ適用しますか？",
      active: "適用する",
      inactive: "保存のみ",
      initialValue: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("適用するを選ぶと保存したprofileをそのまま適用する", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillsctl-tui-apply-test-"));
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
      true,
    ]));

    const state = JSON.parse(readFileSync(cliOptions.statePath, "utf8"));
    assert.equal(state.activeProfile, "safe");
    const managed = state.managed as Array<{ kind: string; ref: string }>;
    assert.deepEqual(
      managed.slice(0, 3).map((entry) => [entry.kind, entry.ref]),
      [
        ["skill", "fixture:sample-skill"],
        ["rules", "fixture:sample-policy"],
        ["hook-package", "fixture:sample-policy"],
      ],
    );
    assert.equal(managed[3].kind, "hook-config");
    assert.match(managed[3].ref, /^generated:[a-f0-9]{64}$/);
    assert.equal(lstatSync(join(cliOptions.targetDir, "sample-skill")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(cliOptions.codexHome, "AGENTS.md")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(cliOptions.codexHome, "hooks.json")).isSymbolicLink(), true);
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
      false,
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

test("新しく選択した候補だけに新規markerを表示する", async () => {
  const receivedOptions: unknown[] = [];
  await runMultiPicker([{
    ref: "fixture:existing-skill",
    description: "existing skill",
    source: "/fixture/existing",
  }, {
    ref: "fixture:new-skill",
    description: "new skill",
    source: "/fixture/new",
  }], "profileに含めるskill", ["fixture:existing-skill"], scriptedPrompts([
    ["fixture:existing-skill", "fixture:new-skill"],
  ], undefined, receivedOptions));

  const promptOptions = receivedOptions[0] as {
    options: (this: { selectedValues: string[] }) => Array<{ label: string }>;
  };
  const selectedOptions = promptOptions.options.call({
    selectedValues: ["fixture:existing-skill", "fixture:new-skill"],
  });
  assert.equal(selectedOptions[0].label, "fixture:existing-skill");
  assert.equal(selectedOptions[1].label, "fixture:new-skill [新規]");

  const deselectedOptions = promptOptions.options.call({
    selectedValues: ["fixture:existing-skill"],
  });
  assert.equal(deselectedOptions[1].label, "fixture:new-skill");
});

test("focus中の候補は検索可能なdescriptionを1行へ短縮して表示する", async () => {
  const receivedOptions: unknown[] = [];
  await runMultiPicker([{
    ref: "fixture:sample-skill",
    description: `needleを含む\n長い説明文${"です".repeat(40)}`,
    source: "/fixture/source",
  }], "profileに含めるskill", [], scriptedPrompts([
    [],
  ], undefined, receivedOptions));

  const promptOptions = receivedOptions[0] as {
    maxItems?: number;
    options: (this: { selectedValues: string[] }) => Array<{
      hint?: string;
      searchText?: string;
    }>;
    filter?: (search: string, option: { hint?: string; searchText?: string }) => boolean;
  };
  const option = promptOptions.options.call({ selectedValues: [] })[0];
  assert.equal(promptOptions.maxItems, 8);
  assert.ok(option.hint);
  assert.equal(option.hint.includes("\n"), false);
  assert.ok(option.hint.endsWith("..."));
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
      false,
    ]));

    const config = JSON.parse(readFileSync(cliOptions.configPath, "utf8"));
    assert.equal(config.profiles.safe.rules, null);
    assert.deepEqual(config.profiles.safe.hooks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
