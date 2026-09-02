import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repoRoot, "tools", "skills-ctl.ts");

test("profileから常時ルールとPR本文guardを導入できる", () => {
  const root = mkdtempSync(join(tmpdir(), "single-review-decision-install-"));
  try {
    const configPath = join(root, "profiles.json");
    const statePath = join(root, "state.json");
    const codexHome = join(root, "codex");
    writeFileSync(configPath, JSON.stringify({
      version: 4,
      profiles: {
        guarded: {
          skills: [],
          rules: ["personal:レビュー判断を1つにする"],
          hooks: ["personal:single-review-decision"],
        },
      },
    }));

    execFileSync(process.execPath, ["--experimental-strip-types", cli, "apply", "guarded", "--yes"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PERSONAL_SKILLS_CONFIG: configPath,
        PERSONAL_SKILLS_STATE: statePath,
        PERSONAL_SKILLS_CODEX_HOME: codexHome,
        PERSONAL_SKILLS_TARGET: join(codexHome, "skills"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.match(
      realpathSync(join(codexHome, "AGENTS.md")),
      /artifacts\/agents-[a-f0-9]{64}\.md$/,
    );
    assert.match(
      readFileSync(join(codexHome, "AGENTS.md"), "utf8"),
      /# 1つのPull Requestで求めるレビュー判断は1つにする/,
    );
    assert.equal(
      realpathSync(join(codexHome, "managed-hooks", "personal", "single-review-decision")),
      join(repoRoot, "hooks", "single-review-decision"),
    );
    const generated = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    assert.match(
      generated.hooks.PreToolUse[0].hooks[0].command,
      /managed-hooks\/personal\/single-review-decision.*guard\.mjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
