import json, os, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import limits


class LimitsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        limits.CLAUDE_SNAPSHOT = self.root / "claude.json"
        limits.CODEX_SESSIONS = self.root / "sessions"
        (self.root / "sessions").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def write_claude(self, five, seven, age_min=0):
        limits.CLAUDE_SNAPSHOT.write_text(json.dumps({"written_at": time.time() - age_min * 60, "rate_limits": {
            "five_hour": {"used_percentage": five, "resets_at": time.time() + 3600},
            "seven_day": {"used_percentage": seven, "resets_at": time.time() + 86400}}}))

    def write_codex(self, used):
        line = json.dumps({"payload": {"rate_limits": {"primary": {"used_percent": used, "window_minutes": 10080, "resets_at": time.time() + 86400},
                                       "secondary": None, "credits": {"has_credits": False}, "plan_type": "pro"}}})
        (self.root / "sessions" / "a.jsonl").write_text('{"x":1}\n' + line + "\n")

    def test_claude_ok_and_handoff(self):
        self.write_codex(30); self.write_claude(20, 40)
        state, code, _ = limits.judge(limits.read_claude(), limits.read_codex())
        self.assertEqual((state, code), ("OK", 0))
        self.write_claude(96, 40)
        state, code, notes = limits.judge(limits.read_claude(), limits.read_codex())
        self.assertEqual((state, code), ("HANDOFF", 2))
        self.assertIn("Codex", notes[0])

    def test_warn_threshold_uses_worst_window(self):
        self.write_codex(10); self.write_claude(10, 88)
        state, code, _ = limits.judge(limits.read_claude(), limits.read_codex())
        self.assertEqual((state, code), ("WARN", 1))

    def test_codex_low_never_hands_off(self):
        self.write_codex(99); self.write_claude(10, 10)
        state, code, notes = limits.judge(limits.read_claude(), limits.read_codex())
        self.assertEqual(state, "WARN")
        self.assertTrue(any("リセット券" in n for n in notes))

    def test_claude_missing_or_stale_is_unknown(self):
        self.write_codex(10)
        self.assertEqual(limits.judge(limits.read_claude(), limits.read_codex())[0], "UNKNOWN")
        self.write_claude(10, 10, age_min=90)
        info = limits.read_claude()
        self.assertFalse(info["known"]); self.assertIn("古い", info["reason"])

    def test_codex_reads_newest_rate_limits(self):
        self.write_codex(42)
        info = limits.read_codex()
        self.assertTrue(info["known"]); self.assertEqual(info["remaining_percent"], 58.0)


if __name__ == "__main__":
    unittest.main()
