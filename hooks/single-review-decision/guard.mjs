#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

function tokenize(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (quote || escaped) return null;
  if (token) tokens.push(token);
  return tokens;
}

function prInvocation(tokens) {
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (basename(tokens[index]) !== "gh" || tokens[index + 1] !== "pr") continue;
    const operation = tokens[index + 2];
    if (operation === "create" || operation === "edit") {
      return { operation, args: tokens.slice(index + 3) };
    }
  }
  return null;
}

function optionValue(args, longName, shortName) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || arg === shortName) return args[index + 1] ?? null;
    if (arg.startsWith(`${longName}=`)) return arg.slice(longName.length + 1);
  }
  return undefined;
}

function reviewerDecisionError(body) {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const headings = lines
    .map((line, index) => line.trim() === "## レビュワーに求める判断" ? index : -1)
    .filter((index) => index >= 0);
  if (headings.length !== 1) {
    return "PR本文には `## レビュワーに求める判断` をちょうど1つ置いてください。";
  }
  const start = headings[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  if (!section) return "レビュワーに求める判断を1つの段落で明記してください。";
  if (/\n\s*\n/.test(section)) return "レビュワーに求める判断は複数段落に分けず、1つにしてください。";
  if (section.split("\n").some((line) => /^\s*#{1,6}\s+/.test(line))) {
    return "レビュワーに求める判断の節には、1つの段落だけを書いてください。";
  }
  if (section.split("\n").some((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line))) {
    return "レビュワーに求める判断を箇条書きにせず、1つの段落にしてください。";
  }
  return null;
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

if (input.tool_name !== "Bash") process.exit(0);
const command = input.tool_input?.command;
if (typeof command !== "string" || !/(?:^|\s)(?:\S*\/)?gh\s+pr\s+(?:create|edit)\b/.test(command)) {
  process.exit(0);
}

const tokens = tokenize(command);
const invocation = tokens ? prInvocation(tokens) : null;
if (!invocation) {
  deny("gh PRコマンドを安全に解析できません。本文を通常ファイルへ保存し、`gh pr create --body-file <path>` を単独で実行してください。");
  process.exit(0);
}

const bodyLiteral = optionValue(invocation.args, "--body", "-b");
const bodyFile = optionValue(invocation.args, "--body-file", "-F");
const changesBody = bodyLiteral !== undefined || bodyFile !== undefined
  || invocation.args.some((arg) => arg === "--fill" || arg.startsWith("--fill-"));
if (invocation.operation === "edit" && !changesBody) process.exit(0);

let body;
if (bodyLiteral !== undefined) {
  if (bodyLiteral === null) {
    deny("`--body` の値がありません。");
    process.exit(0);
  }
  body = bodyLiteral;
} else if (bodyFile !== undefined) {
  if (!bodyFile || bodyFile === "-") {
    deny("stdinではなく通常ファイルを `--body-file` に指定してください。");
    process.exit(0);
  }
  try {
    body = readFileSync(resolve(input.cwd || process.cwd(), bodyFile), "utf8");
  } catch {
    deny(`PR本文ファイルを読めません: ${bodyFile}`);
    process.exit(0);
  }
} else {
  deny("PR本文を通常ファイルへ保存し、`--body-file` で明示してください。");
  process.exit(0);
}

const error = reviewerDecisionError(body);
if (error) deny(error);
