import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import test from "node:test";

const notice = new URL("./notice.mjs", import.meta.url);

function run(input) {
  return execFileSync(process.execPath, [notice.pathname], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
}

function contextOf(input) {
  const output = run(input);
  assert.notEqual(output, "");
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
  return parsed.hookSpecificOutput.additionalContext;
}

function call(toolInput, extra = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "spawn_agent",
    model: "gpt-5.6-luna",
    ...extra,
    tool_input: toolInput,
  };
}

test("上位モデル指定はモデルと推論レベルを含む注意contextを返す", () => {
  for (const model of ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]) {
    const context = contextOf(call({ model, reasoning_effort: "max" }));
    assert.match(context, new RegExp(model));
    assert.match(context, /reasoning_effort=max/);
    assert.match(context, /このタスクの実行に、このモデル・推論レベルが本当に必要か確認してください/);
  }
});

test("Lunaの全推論レベルとsparkは注意contextを返さない", () => {
  assert.equal(run(call({ model: "gpt-5.6-luna", reasoning_effort: "max" })), "");
  assert.equal(run(call({ model: "gpt-5.6-luna", reasoning_effort: "xhigh" })), "");
  assert.equal(run(call({ model: "gpt-5.3-codex-spark", reasoning_effort: "max" })), "");
});

test("model省略時は親Astraを実効値と断定せず継承候補として注意する", () => {
  const context = contextOf(call({ reasoning_effort: "high" }, { model: "gpt-6-astra" }));
  assert.match(context, /親のモデル（継承候補）=gpt-6-astra/);
  assert.match(context, /実効モデルの確定値ではありません/);
  assert.match(context, /reasoning_effort=high/);
});

test("custom agent_typeは明示されたLunaでも実効モデルを未確定として注意する", () => {
  const context = contextOf(call({ model: "gpt-5.6-luna", reasoning_effort: "max", agent_type: "luna-worker" }));
  assert.match(context, /custom agent_type=luna-worker/);
  assert.match(context, /指定モデル候補=gpt-5.6-luna/);
  assert.match(context, /実効モデルは未確定です/);
  assert.doesNotMatch(context, /実効モデル=gpt-5.6-luna/);
});

test("明示modelのeffort省略時は親のeffortを実効値として表示しない", () => {
  const context = contextOf(call({ model: "gpt-6-astra" }, {
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
  }));
  assert.match(context, /model=gpt-6-astra/);
  assert.match(context, /reasoning_effort=指定なし/);
  assert.doesNotMatch(context, /reasoning_effort=max/);
});

test("未知モデルはランクを断定せず確認を促す", () => {
  const context = contextOf(call({ model: "vendor-model-unknown", reasoning_effort: "medium" }));
  assert.match(context, /ランクは判定できない/);
  assert.match(context, /実効モデルと推論レベルを確認してください/);
});

test("対象外のtool、event、invalid stdinは静かに通過する", () => {
  assert.equal(run(call({ model: "gpt-6-astra", reasoning_effort: "max" }, { tool_name: "Bash" })), "");
  assert.equal(run(call({ model: "gpt-6-astra", reasoning_effort: "max" }, { hook_event_name: "PostToolUse" })), "");
  assert.equal(run("not-json"), "");
  assert.equal(run(JSON.stringify([])), "");
});

test("表示値の改行と過大な長さを制限する", () => {
  const context = contextOf(call({
    model: `gpt-6-astra\n${"x".repeat(200)}`,
    reasoning_effort: `max\n${"y".repeat(200)}`,
    role: `reviewer\n${"z".repeat(200)}`,
  }));
  assert.doesNotMatch(context, /[\r\n]/);
  assert.ok(context.length < 400);
});

test("注意contextはpending callを変更・拒否するfieldを含めない", () => {
  const output = JSON.parse(run(call({ model: "gpt-6-astra", reasoning_effort: "max" })));
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(output.hookSpecificOutput.updatedInput, undefined);
});
