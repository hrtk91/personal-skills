import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guard = new URL("./guard.mjs", import.meta.url);

function run(command, cwd) {
  return execFileSync(process.execPath, [guard.pathname], {
    cwd,
    input: JSON.stringify({
      tool_name: "Bash",
      cwd,
      tool_input: { command },
    }),
    encoding: "utf8",
  });
}

test("allows a PR body with one plain reviewer decision", () => {
  const root = mkdtempSync(join(tmpdir(), "review-decision-hook-"));
  try {
    const body = join(root, "body.md");
    writeFileSync(body, "## レビュワーに求める判断\n\nAPIの競合応答を409へ統一してよいか。\n\n## 今回含めないこと\n\nCLI対応\n");
    assert.equal(run(`gh pr create --body-file '${body}'`, root), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks missing, listed, and implicit reviewer decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "review-decision-hook-"));
  try {
    const body = join(root, "body.md");
    writeFileSync(body, "## 概要\n\n変更しました。\n");
    assert.match(run(`gh pr create --body-file '${body}'`, root), /permissionDecision.*deny/);
    writeFileSync(body, "## レビュワーに求める判断\n\n- API変更\n- DB変更\n");
    assert.match(run(`gh pr edit --body-file '${body}'`, root), /箇条書き/);
    assert.match(run("gh pr create --fill", root), /--body-file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not block commands or PR edits that do not change the body", () => {
  const root = mkdtempSync(join(tmpdir(), "review-decision-hook-"));
  try {
    assert.equal(run("git status", root), "");
    assert.equal(run("gh pr edit --add-label ready", root), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
