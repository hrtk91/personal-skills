#!/usr/bin/env node

import { resolve } from "node:path";
import {
  getProfile,
  parseOptions,
  readConfig,
  readState,
} from "./skills-ctl/model.ts";
import { addSource, printSourceList } from "./skills-ctl/catalog.ts";
import { desiredPlan } from "./skills-ctl/profile-plan.ts";
import {
  applyProfile,
  detachLegacyRulesEntries,
  inspectStatus,
  printPlan,
  rollback,
  validatePlan,
} from "./skills-ctl/activation.ts";
import {
  printProfile,
  printProfileList,
  printSkillList,
  profilePickerTui,
  profileTui,
} from "./skills-ctl/tui.ts";

function usage(): void {
  console.log(`personal-skills harness管理\n\n使い方:\n  harnessctl                         profileを選択・作成してresourceを編集\n  harnessctl tui [name]              指定profileを編集\n  harnessctl skills\n  harnessctl sources list\n  harnessctl sources add <path> [--id <id>]\n  harnessctl profile list\n  harnessctl profile show <name>\n  harnessctl profile tui [name]\n  harnessctl plan <name>\n  harnessctl apply <name> [--dry-run] [--yes]\n  harnessctl status\n  harnessctl rollback [--yes]\n\n`);
  console.log("  --verbose, -v        skillのpathと説明を表示");
}

async function main(): Promise<void> {
  const firstArg = process.argv[2];
  const hasCommand = Boolean(
    firstArg && (!firstArg.startsWith("-") || firstArg === "--help" || firstArg === "-h"),
  );
  const command = hasCommand ? process.argv[2] : "tui";
  const { positionals, options } = parseOptions(
    hasCommand ? process.argv.slice(3) : process.argv.slice(2),
  );

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    case "tui":
      if (positionals[0]) await profileTui(positionals[0], options);
      else await profilePickerTui(options);
      return;
    case "skills": {
      printSkillList(readConfig(options.configPath), options.verbose);
      return;
    }
    case "sources": {
      const subcommand = positionals[0] ?? "list";
      if (subcommand === "list") {
        printSourceList(readConfig(options.configPath));
        return;
      }
      if (subcommand === "add") {
        const path = positionals[1];
        if (!path) throw new Error("sources addにはdirectory pathが必要です");
        addSource(path, options.sourceId, options);
        return;
      }
      throw new Error(`不明なsources commandです: ${subcommand}`);
    }
    case "status":
      inspectStatus(readState(options.statePath, options.targetDir, options.codexHome));
      return;
    case "rollback":
      await rollback(options);
      return;
    case "plan":
    case "apply": {
      const name = positionals[0];
      if (!name) throw new Error(`${command}にはprofile名が必要です`);
      const config = readConfig(options.configPath);
      const profile = getProfile(config, name);
      if (command === "plan") {
        const state = readState(options.statePath, options.targetDir, options.codexHome);
        state.targetDir = resolve(options.targetDir);
        state.codexHome = resolve(options.codexHome);
        const migratedState = detachLegacyRulesEntries(state);
        const plan = desiredPlan(
          profile,
          migratedState.targetDir,
          migratedState.codexHome,
          options.statePath,
          config,
        );
        validatePlan(plan.entries, migratedState, migratedState.targetDir);
        printPlan(plan.entries, migratedState);
        return;
      }
      await applyProfile(name, profile, config, options);
      return;
    }
    case "profile": {
      const subcommand = positionals[0] ?? "list";
      const config = readConfig(options.configPath);
      if (subcommand === "list") {
        printProfileList(config);
        return;
      }
      if (subcommand === "show") {
        const name = positionals[1];
        if (!name) throw new Error("profile showにはprofile名が必要です");
        printProfile(config, name);
        return;
      }
      if (subcommand === "tui") {
        if (positionals[1]) await profileTui(positionals[1], options);
        else await profilePickerTui(options);
        return;
      }
      throw new Error(`不明なprofile commandです: ${subcommand}`);
    }
    default:
      throw new Error(`不明なcommandです: ${command}`);
  }
}

main().catch((error) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
