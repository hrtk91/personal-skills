#!/usr/bin/env node

import { readFileSync } from "node:fs";

const EVENT_NAME = "PreToolUse";
const TOOL_NAMES = new Set(["spawn_agent", "Agent", "collaboration.spawn_agent"]);
const BUILTIN_ROLES = new Set(["default", "worker", "explorer"]);
const SILENT_MODELS = new Set(["gpt-5.6-luna", "gpt-5.3-codex-spark"]);
const MAX_DISPLAY_LENGTH = 80;
const NOT_SPECIFIED = "未指定";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(record, key) {
  if (!(key in record) || record[key] === null || record[key] === undefined) {
    return { valid: true, value: null };
  }
  if (typeof record[key] !== "string") return { valid: false, value: null };
  const value = record[key].trim();
  return { valid: true, value: value || null };
}

function displayValue(value) {
  if (typeof value !== "string" || value.length === 0) return NOT_SPECIFIED;

  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[<>{}`]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return NOT_SPECIFIED;

  const characters = [...normalized];
  if (characters.length <= MAX_DISPLAY_LENGTH) return normalized;
  return `${characters.slice(0, MAX_DISPLAY_LENGTH - 1).join("")}…`;
}

function classifyModel(model) {
  if (SILENT_MODELS.has(model)) return "silent";
  if (
    model === "gpt-5.6" ||
    model === "gpt-5.6-sol" ||
    model === "gpt-5.6-terra" ||
    model === "gpt-6-astra" ||
    model === "gpt-5.5" ||
    /^gpt-5\.4(?:$|[-.])/u.test(model)
  ) {
    return "known-notice";
  }
  return "unknown";
}

function effortText(effort) {
  return `reasoning_effort=${effort === null ? "指定なし" : displayValue(effort)}`;
}

function standardNotice(model, effort, role) {
  const roleText = role ? `, agent_type=${displayValue(role)}` : "";
  return `上位モデル指定: model=${displayValue(model)}, ${effortText(effort)}${roleText}。このタスクの実行に、このモデル・推論レベルが本当に必要か確認してください。`;
}

function unknownNotice(model, effort, role) {
  const roleText = role ? `, agent_type=${displayValue(role)}` : "";
  return `指定モデル: model=${displayValue(model)}, ${effortText(effort)}${roleText}。モデルのランクは判定できないため、実効モデルと推論レベルを確認してください。`;
}

function inheritedNotice(parentModel, effort, role) {
  const roleText = role ? `, agent_type=${displayValue(role)}` : "";
  return `subagentのmodel指定は省略されています。親のモデル（継承候補）=${displayValue(parentModel)}, ${effortText(effort)}${roleText}。これは実効モデルの確定値ではありません。このタスクの実行に、このモデル・推論レベルが本当に必要か確認してください。`;
}

function inheritedUnknownNotice(effort, role) {
  const roleText = role ? `, agent_type=${displayValue(role)}` : "";
  return `subagentのmodel指定は省略され、親のモデル（継承候補）も特定できません。${effortText(effort)}${roleText}。実効モデルと推論レベルを確認してください。`;
}

function customRoleNotice(model, parentModel, effort, role) {
  const modelText = model
    ? `指定モデル候補=${displayValue(model)}`
    : `親のモデル（継承候補）=${displayValue(parentModel)}`;
  return `custom agent_type=${displayValue(role)} はモデル設定を上書きする可能性があるため、実効モデルは未確定です。${modelText}, ${effortText(effort)}。このタスクの実行に、このモデル・推論レベルが本当に必要か、指定解決の結果を確認してください。`;
}

function outputContext(additionalContext) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT_NAME,
      additionalContext,
    },
  })}\n`);
}

function readInput() {
  try {
    const raw = readFileSync(0, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function noticeFor(input) {
  if (!input || input.hook_event_name !== EVENT_NAME || !TOOL_NAMES.has(input.tool_name)) {
    return null;
  }

  if (!isRecord(input.tool_input)) return null;
  const toolInput = input.tool_input;
  const requestedModel = optionalString(toolInput, "model");
  const requestedEffort = optionalString(toolInput, "reasoning_effort");
  const requestedAgentType = optionalString(toolInput, "agent_type");
  const legacyRole = optionalString(toolInput, "role");
  const parentModel = optionalString(input, "model");
  if (!requestedModel.valid || !requestedEffort.valid || !requestedAgentType.valid || !legacyRole.valid || !parentModel.valid) {
    return null;
  }

  const model = requestedModel.value;
  const effort = requestedEffort.value;
  const role = requestedAgentType.value ?? legacyRole.value;
  const builtinRole = role === null || BUILTIN_ROLES.has(role);

  // A custom role can replace even an explicitly supplied model. Keep its
  // effective value unresolved instead of hard-coding exceptions by role name.
  if (!builtinRole) return customRoleNotice(model, parentModel.value, effort, role);

  if (model !== null) {
    const classification = classifyModel(model);
    if (classification === "silent") return null;
    if (classification === "known-notice") return standardNotice(model, effort, role);
    return unknownNotice(model, effort, role);
  }

  const candidate = parentModel.value;
  if (candidate === null) return inheritedUnknownNotice(effort, role);
  if (classifyModel(candidate) === "silent") return null;
  if (classifyModel(candidate) === "known-notice") return inheritedNotice(candidate, effort, role);
  return inheritedUnknownNotice(effort, role);
}

const context = noticeFor(readInput());
if (context) outputContext(context);
