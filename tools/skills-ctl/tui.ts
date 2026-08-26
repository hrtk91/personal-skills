import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type Config,
  type Options,
  readConfig,
  getProfile,
  writeJson,
} from "./model.ts";
import {
  discoverSkills,
  harnessMap,
  hookMap,
} from "./catalog.ts";

export function commandExists(command: string): boolean {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export interface PickerItem {
  ref: string;
  description: string;
  source: string;
}

export function runMultiFzf(items: PickerItem[], prompt: string): string[] | null {
  if (!commandExists("fzf")) {
    throw new Error("fzfが必要です。先に導入してください");
  }

  const duplicateNames = new Map<string, number>();
  for (const item of items) {
    const name = item.ref.slice(item.ref.indexOf(":") + 1);
    duplicateNames.set(name, (duplicateNames.get(name) ?? 0) + 1);
  }
  const refWidth = Math.max("(none)".length, ...items.map((item) => item.ref.length));
  const candidates = [
    `${"(なし)".padEnd(refWidth + 2)}\t選択を解除\t`,
    ...items.map((item) => {
      const name = item.ref.slice(item.ref.indexOf(":") + 1);
      const location = duplicateNames.get(name)! > 1 ? item.source : "";
      return `${item.ref.padEnd(refWidth + 2)}\t${item.description}\t${location}`;
    })
  ].join("\n");
  const result = spawnSync("fzf", [
    "--multi",
    "--height=80%",
    "--layout=reverse",
    "--border",
    "--delimiter=\t",
    "--with-nth=1,2,3",
    `--prompt=${prompt}> `,
    "--header=TAB: 複数選択 / ENTER: 続行 / ESC: 中止 / (なし): 選択解除",
  ], {
    input: candidates,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (result.status !== 0) return null;
  const selected = result.stdout
    .split("\n")
    .map((line) => line.split("\t", 1)[0].trim())
    .filter(Boolean);
  return selected.includes("(なし)") ? [] : selected;
}

export function runSingleFzf(items: PickerItem[], prompt: string): string | null | undefined {
  if (!commandExists("fzf")) throw new Error("fzfが必要です。先に導入してください");
  const candidates = [
    "(なし)\t選択を解除",
    ...items.map((item) => `${item.ref}\t${item.description}\t${item.source}`),
  ].join("\n");
  const result = spawnSync("fzf", [
    "--height=60%",
    "--layout=reverse",
    "--border",
    "--delimiter=\t",
    "--with-nth=1,2,3",
    `--prompt=${prompt}> `,
    "--header=ENTER: 続行 / ESC: 中止 / (なし): 選択解除",
  ], {
    input: candidates,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) return undefined;
  const selected = result.stdout.split("\n")[0]?.split("\t", 1)[0].trim();
  return selected === "(なし)" ? null : selected;
}

export function runProfileFzf(config: Config): string | null {
  if (!commandExists("fzf")) {
    throw new Error("fzfが必要です。先に導入してください");
  }

  const profileNames = Object.keys(config.profiles).sort();
  const candidates = [
    ...profileNames.map((name) => `${name}\t${config.profiles[name].skills.length} skills`),
    "+ profileを作成\t新しいprofile",
  ].join("\n");
  const result = spawnSync("fzf", [
    "--height=50%",
    "--layout=reverse",
    "--border",
    "--delimiter=\t",
    "--with-nth=1,2",
    "--prompt=profiles> ",
    "--header=ENTER: 編集 / ESC: 中止",
  ], {
    input: candidates,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (result.status !== 0) return null;
  return result.stdout.split("\n")[0]?.split("\t", 1)[0].trim() || null;
}

export function validateProfileName(name: string): void {
  if (!name.trim() || name === "." || name === ".." || /[\\/\0-\x1f]/.test(name)) {
    throw new Error(`profile名が不正です: ${name}`);
  }
}

export async function createProfileFromPicker(config: Config): Promise<string | null> {
  const rl = createInterface({ input, output });
  const name = (await rl.question("新しいprofile名: ")).trim();
  rl.close();
  if (!name) {
    console.log("中止しました");
    return null;
  }
  validateProfileName(name);
  if (config.profiles[name]) throw new Error(`profileは作成済みです: ${name}`);
  return name;
}

export async function profilePickerTui(options: Options): Promise<void> {
  const config = readConfig(options.configPath);
  const selected = runProfileFzf(config);
  if (!selected) {
    console.log("中止しました");
    return;
  }
  const profileName = selected === "+ profileを作成"
    ? await createProfileFromPicker(config)
    : selected;
  if (!profileName) return;
  await profileTui(profileName, options);
}

export function profileTui(profileName: string, options: Options): void {
  validateProfileName(profileName);
  const config = readConfig(options.configPath);
  const skills = discoverSkills(config);
  if (skills.length === 0) throw new Error("skillが見つかりません");
  const selectedSkills = runMultiFzf(skills.map((skill) => ({
    ref: skill.ref,
    description: skill.description,
    source: skill.source,
  })), "skills");
  if (selectedSkills === null) {
    console.log("中止しました");
    return;
  }

  const harnesses = [...harnessMap(config).values()];
  const selectedHarness = runSingleFzf(harnesses.map((harness) => ({
    ref: harness.ref,
    description: "常時読み込むAGENTS.md",
    source: harness.source,
  })), "harness");
  if (selectedHarness === undefined) {
    console.log("中止しました");
    return;
  }

  const hooks = [...hookMap(config).values()];
  const selectedHooks = runMultiFzf(hooks.map((hook) => ({
    ref: hook.ref,
    description: "Codex hook package",
    source: hook.source,
  })), "hooks");
  if (selectedHooks === null) {
    console.log("中止しました");
    return;
  }

  config.profiles[profileName] = {
    description: config.profiles[profileName]?.description ?? "skillsctlで作成",
    skills: selectedSkills,
    harness: selectedHarness,
    hooks: selectedHooks,
  };
  writeJson(options.configPath, config);
  console.log(`profileを保存しました: ${profileName}`);
  console.log(`次の操作: npm run skillsctl -- plan ${profileName}`);
}

export function printSkillList(config: Config, verbose: boolean): void {
  const skills = discoverSkills(config);
  if (!verbose) {
    const bySource = new Map<string, SkillInfo[]>();
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
    console.log(`${skill.ref}\t${skill.source}\t${skill.description}`);
  }
}

export function printProfileList(config: Config): void {
  const names = Object.keys(config.profiles).sort();
  if (names.length === 0) {
    console.log("profileはありません");
    return;
  }
  for (const name of names) {
    const profile = getProfile(config, name);
    console.log(`${name}\tskill ${profile.skills.length}件, harness ${profile.harness ? "1" : "0"}件, hook ${profile.hooks.length}件`);
  }
}

export function printProfile(config: Config, name: string): void {
  const profile = getProfile(config, name);
  console.log(JSON.stringify({ name, ...profile }, null, 2));
}
