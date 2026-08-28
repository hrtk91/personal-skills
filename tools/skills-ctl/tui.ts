import {
  autocomplete,
  autocompleteMultiselect,
  confirm,
  isCancel,
  text,
} from "@clack/prompts";
import {
  type Config,
  type Options,
  readConfig,
  getProfile,
  writeJson,
} from "./model.ts";
import {
  discoverSkills,
  ruleMap,
  hookMap,
} from "./catalog.ts";
import { applyProfile } from "./activation.ts";

export interface PickerItem {
  ref: string;
  description: string;
  source: string;
}

interface PromptOption {
  value: string;
  label: string;
  hint?: string;
  searchText?: string;
}

interface AutocompleteContext {
  selectedValues: string[];
}

type PromptOptions = PromptOption[] | ((this: AutocompleteContext) => PromptOption[]);

interface AutocompleteOptions {
  message: string;
  options: PromptOptions;
  initialValue?: string;
  initialValues?: string[];
  maxItems?: number;
  placeholder?: string;
  required?: boolean;
  filter?: (search: string, option: PromptOption) => boolean;
}

interface TextOptions {
  message: string;
  validate?: (value: string) => string | undefined;
}

interface ConfirmOptions {
  message: string;
  active?: string;
  inactive?: string;
  initialValue?: boolean;
}

export interface PromptFunctions {
  autocomplete: (options: AutocompleteOptions) => Promise<unknown>;
  autocompleteMultiselect: (options: AutocompleteOptions) => Promise<unknown>;
  confirm: (options: ConfirmOptions) => Promise<unknown>;
  text: (options: TextOptions) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
}

const defaultPromptFunctions: PromptFunctions = {
  autocomplete: (options) => autocomplete(options),
  autocompleteMultiselect: (options) => autocompleteMultiselect(options),
  confirm: (options) => confirm(options),
  text: (options) => text(options),
  isCancel,
};

export function pickerOptions(items: PickerItem[]): PromptOption[] {
  const duplicateNames = new Map<string, number>();
  for (const item of items) {
    const name = item.ref.slice(item.ref.indexOf(":") + 1);
    duplicateNames.set(name, (duplicateNames.get(name) ?? 0) + 1);
  }
  return items.map((item) => {
    const name = item.ref.slice(item.ref.indexOf(":") + 1);
    const location = duplicateNames.get(name)! > 1 ? item.source : "";
    return {
      value: item.ref,
      label: item.ref,
      hint: descriptionHint(item.description, item.ref),
      searchText: [item.ref, item.description, location].filter(Boolean).join("\n"),
    };
  });
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += character.codePointAt(0)! <= 0x7f ? 1 : 2;
  return width;
}

function truncateToWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value;
  const contentWidth = Math.max(0, maxWidth - 3);
  let result = "";
  let width = 0;
  for (const character of value) {
    const characterWidth = character.codePointAt(0)! <= 0x7f ? 1 : 2;
    if (width + characterWidth > contentWidth) break;
    result += character;
    width += characterWidth;
  }
  return `${result}...`;
}

function descriptionHint(description: string, label: string): string | undefined {
  const normalized = description.replaceAll(/\s+/g, " ").trim();
  const availableWidth = Math.min(48, (process.stdout.columns ?? 80) - displayWidth(label) - 10);
  return normalized && availableWidth >= 8
    ? truncateToWidth(normalized, availableWidth)
    : undefined;
}

function dynamicMultiPickerOptions(
  items: PickerItem[],
  existingValues: string[],
): (this: AutocompleteContext) => PromptOption[] {
  const options = pickerOptions(items);
  const itemByRef = new Map(items.map((item) => [item.ref, item]));
  const existing = new Set(existingValues);
  return function () {
    const selected = new Set(this.selectedValues);
    for (const option of options) {
      const item = itemByRef.get(option.value)!;
      const isNew = selected.has(option.value) && !existing.has(option.value);
      option.label = `${option.value}${isNew ? " [新規]" : ""}`;
      option.hint = descriptionHint(item.description, option.label);
    }
    return options;
  };
}

function filterPickerOption(search: string, option: PromptOption): boolean {
  const query = search.toLowerCase();
  return [option.label, option.value, option.hint, option.searchText]
    .some((value) => value?.toLowerCase().includes(query));
}

export async function runMultiPicker(
  items: PickerItem[],
  message: string,
  initialValues: string[] = [],
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<string[] | null> {
  if (items.length === 0) return [];
  const available = new Set(items.map((item) => item.ref));
  const existingValues = initialValues.filter((value) => available.has(value));
  const promptInitialValues = existingValues.length <= 1
    ? existingValues
    : [...existingValues.slice(1), existingValues[0]];
  const result = await prompts.autocompleteMultiselect({
    message,
    options: dynamicMultiPickerOptions(items, existingValues),
    initialValues: promptInitialValues,
    maxItems: 8,
    placeholder: "入力して絞り込み",
    required: false,
    filter: filterPickerOption,
  });
  if (prompts.isCancel(result)) return null;
  const selectedValues = result as string[];
  const selected = new Set(selectedValues);
  const existing = new Set(existingValues);
  return [
    ...existingValues.filter((value) => selected.has(value)),
    ...selectedValues.filter((value) => !existing.has(value)),
  ];
}

export async function runSinglePicker(
  items: PickerItem[],
  message: string,
  initialValue: string | null = null,
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<string | null | undefined> {
  if (items.length === 0) return null;
  const result = await prompts.autocomplete({
    message,
    options: [
      { value: "", label: "(なし)", hint: "選択を解除" },
      ...pickerOptions(items),
    ],
    initialValue: initialValue ?? "",
    maxItems: 8,
    placeholder: "入力して絞り込み",
    filter: filterPickerOption,
  });
  if (prompts.isCancel(result)) return undefined;
  return result === "" ? null : result as string;
}

const createProfileValue = "\0create-profile";

export async function runProfilePicker(
  config: Config,
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<string | null> {
  const result = await prompts.autocomplete({
    message: "編集するprofile",
    options: [
      ...Object.keys(config.profiles).sort().map((name) => ({
        value: name,
        label: name,
        hint: `${config.profiles[name].skills.length} skills`,
      })),
      { value: createProfileValue, label: "+ profileを作成", hint: "新しいprofile" },
    ],
    placeholder: "入力して絞り込み",
  });
  if (prompts.isCancel(result)) return null;
  return result === createProfileValue ? "+ profileを作成" : result as string;
}

export function validateProfileName(name: string): void {
  if (!name.trim() || name === "." || name === ".." || /[\\/\0-\x1f]/.test(name)) {
    throw new Error(`profile名が不正です: ${name}`);
  }
}

export async function createProfileFromPicker(
  config: Config,
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<string | null> {
  const result = await prompts.text({
    message: "新しいprofile名",
    validate: (value) => {
      try {
        validateProfileName(value.trim());
        if (config.profiles[value.trim()]) return "profileは作成済みです";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(result)) return null;
  const name = (result as string).trim();
  if (!name) {
    console.log("中止しました");
    return null;
  }
  return name;
}

export async function profilePickerTui(
  options: Options,
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<void> {
  const config = readConfig(options.configPath);
  const selected = await runProfilePicker(config, prompts);
  if (!selected) {
    console.log("中止しました");
    return;
  }
  const profileName = selected === "+ profileを作成"
    ? await createProfileFromPicker(config, prompts)
    : selected;
  if (!profileName) return;
  await profileTui(profileName, options, prompts);
}

export async function profileTui(
  profileName: string,
  options: Options,
  prompts: PromptFunctions = defaultPromptFunctions,
): Promise<void> {
  validateProfileName(profileName);
  const config = readConfig(options.configPath);
  const currentProfile = config.profiles[profileName];
  const skills = discoverSkills(config);
  if (skills.length === 0) throw new Error("skillが見つかりません");
  const selectedSkills = await runMultiPicker(skills.map((skill) => ({
    ref: skill.ref,
    description: skill.description,
    source: skill.source,
  })), "profileに含めるskill", currentProfile?.skills ?? [], prompts);
  if (selectedSkills === null) {
    console.log("中止しました");
    return;
  }

  const rules = [...ruleMap(config).values()];
  const selectedRules = await runSinglePicker(rules.map((rule) => ({
    ref: rule.ref,
    description: "常時読み込むAGENTS.md",
    source: rule.source,
  })), "profileで使う常時ルール", currentProfile?.rules ?? null, prompts);
  if (selectedRules === undefined) {
    console.log("中止しました");
    return;
  }

  const hooks = [...hookMap(config).values()];
  const selectedHooks = await runMultiPicker(hooks.map((hook) => ({
    ref: hook.ref,
    description: "Codex hook package",
    source: hook.source,
  })), "profileに含めるhook", currentProfile?.hooks ?? [], prompts);
  if (selectedHooks === null) {
    console.log("中止しました");
    return;
  }

  config.profiles[profileName] = {
    description: config.profiles[profileName]?.description ?? "skillsctlで作成",
    skills: selectedSkills,
    rules: selectedRules,
    hooks: selectedHooks,
  };
  writeJson(options.configPath, config);
  console.log(`profileを保存しました: ${profileName}`);

  const shouldApply = await prompts.confirm({
    message: "保存したprofileを今すぐ適用しますか？",
    active: "適用する",
    inactive: "保存のみ",
    initialValue: false,
  });
  if (prompts.isCancel(shouldApply) || shouldApply !== true) {
    console.log(`後で適用: skillsctl apply ${profileName}`);
    return;
  }

  await applyProfile(
    profileName,
    getProfile(config, profileName),
    config,
    { ...options, yes: true },
  );
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
    console.log(`${name}\tskill ${profile.skills.length}件, rules ${profile.rules ? "1" : "0"}件, hook ${profile.hooks.length}件`);
  }
}

export function printProfile(config: Config, name: string): void {
  const profile = getProfile(config, name);
  console.log(JSON.stringify({ name, ...profile }, null, 2));
}
