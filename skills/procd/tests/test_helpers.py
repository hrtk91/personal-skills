import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.settings = self.root / "settings.json"
        self.original = {"model": "example-model", "statusLine": {"type": "command", "command": "echo status"},
                         "hooks": {"SessionStart": [{"matcher": "resume", "hooks": [
                             {"type": "command", "command": "python3 old-tool/procd.py unread --ack"}]}],
                                   "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]}}
        self.settings.write_text(json.dumps(self.original))

    def install(self, *args, procd=None):
        return subprocess.run([sys.executable, str(SCRIPTS / "install-claude-hooks.py"),
                               "--settings", str(self.settings), "--procd", str(procd or SCRIPTS / "procd.py"),
                               "--socket", str(self.root / "test.sock"), *args],
                              text=True, capture_output=True, timeout=5)

    def backup(self):
        return self.settings.with_name("settings.json.bak-procd")

    def test_dry_run_preserves_file_and_does_not_create_backup(self):
        before = self.settings.read_bytes()
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        planned = json.loads(result.stdout)
        self.assertEqual(planned["model"], self.original["model"])
        self.assertEqual(len(planned["hooks"]["SessionStart"]), 2)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertFalse(self.backup().exists())

    def test_install_is_idempotent_and_preserves_unmanaged_hooks_and_first_backup(self):
        before = self.settings.read_bytes()
        self.assertEqual(self.install().returncode, 0)
        installed = json.loads(self.settings.read_text())
        self.assertEqual(installed["hooks"]["SessionStart"][0], self.original["hooks"]["SessionStart"][0])
        self.assertEqual(installed["hooks"]["Stop"], self.original["hooks"]["Stop"])
        self.assertEqual(installed["statusLine"], self.original["statusLine"])
        first = self.settings.read_bytes()
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.settings.read_bytes(), first)
        self.assertEqual(self.backup().read_bytes(), before)
        installed["theme"] = "user-changed"
        self.settings.write_text(json.dumps(installed))
        self.assertEqual(self.install("--consumer", "different-reader").returncode, 0)
        self.assertEqual(self.backup().read_bytes(), before)
        self.assertEqual(json.loads(self.settings.read_text())["theme"], "user-changed")

    def test_remove_retains_other_handlers_in_a_managed_group(self):
        self.assertEqual(self.install().returncode, 0)
        installed = json.loads(self.settings.read_text())
        managed = installed["hooks"]["UserPromptSubmit"][0]
        user_handler = {"type": "command", "command": "echo user"}
        managed["hooks"].append(user_handler)
        self.settings.write_text(json.dumps(installed))
        result = self.install("--remove")
        self.assertEqual(result.returncode, 0, result.stderr)
        remaining = json.loads(self.settings.read_text())
        self.assertEqual(remaining["hooks"]["SessionStart"], self.original["hooks"]["SessionStart"])
        self.assertEqual(remaining["hooks"]["UserPromptSubmit"], [{"hooks": [user_handler]}])
        self.assertEqual(remaining["hooks"]["Stop"], self.original["hooks"]["Stop"])

    def test_invalid_hook_shape_is_rejected_without_writing(self):
        self.settings.write_text('{"hooks":{"SessionStart":{}}}')
        before = self.settings.read_bytes()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertFalse(self.backup().exists())

    def test_symlink_settings_are_rejected_without_changing_target(self):
        target = self.root / "target.json"
        self.settings.rename(target)
        self.settings.symlink_to(target)
        before = target.read_bytes()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), before)
        self.assertTrue(self.settings.is_symlink())

    def test_generated_hook_executes_with_spaces_and_shell_metacharacters(self):
        tool = self.root / "tool space's $value%" / "procd.py"
        tool.parent.mkdir()
        tool.write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n')
        result = self.install("--dry-run", procd=tool)
        self.assertEqual(result.returncode, 0, result.stderr)
        command = json.loads(result.stdout)["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        executed = subprocess.run(command, shell=True, text=True, capture_output=True, timeout=5)
        self.assertEqual(executed.returncode, 0, executed.stderr)
        self.assertEqual(json.loads(executed.stdout), ["--socket", str(self.root / "test.sock"),
                                                      "unread", "--consumer", "claude-hooks", "--ack"])

    def test_new_settings_are_private_and_remove_without_settings_is_noop(self):
        self.settings.unlink()
        self.assertEqual(self.install("--remove").returncode, 0)
        self.assertFalse(self.settings.exists())
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.backup().exists())

    def test_service_renderer_preserves_restart_boundary_and_escapes_paths(self):
        tool = self.root / 'tool % $ " @STATE_DIR@'
        tool.mkdir()
        (tool / "procd.py").touch()
        result = subprocess.run([sys.executable, str(SCRIPTS / "render-service.py"),
                                 "--procd-root", str(tool), "--socket", "@test-socket",
                                 "--state-dir", str(self.root / "private-state")],
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("KillMode=process\n", result.stdout)
        self.assertIn('tool %% $$ \\" @STATE_DIR@/procd.py', result.stdout)
        self.assertIn('--socket "@test-socket"', result.stdout)
        self.assertIn('--state-dir "' + str(self.root / "private-state") + '"', result.stdout)
        self.assertNotIn("@PROCD_SCRIPT@", result.stdout)

    def test_service_renderer_rejects_relative_state_or_line_injection(self):
        for state in ("relative-state", str(self.root) + "\nInjected=bad"):
            with self.subTest(state=state):
                result = subprocess.run([sys.executable, str(SCRIPTS / "render-service.py"),
                                         "--socket", str(self.root / "test.sock"), "--state-dir", state],
                                        text=True, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
