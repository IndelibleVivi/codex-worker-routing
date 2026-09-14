import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "integrations/main-session" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


hook = module("main_session")
installer = module("install")


class MainSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.note = self.root / "main.md"
        self.content = "PRIVATE_START\n" + "合成的主会话说明。\n" * 800 + "PRIVATE_END\n"
        self.note.write_text(self.content)

    def test_all_root_start_sources_deliver_full_file(self):
        for source in ("startup", "resume", "clear", "compact"):
            result = hook.output_for({"hook_event_name": "SessionStart", "source": source}, self.note)
            self.assertIn(self.content, result["hookSpecificOutput"]["additionalContext"])

    def test_worker_events_do_not_read_private_file(self):
        absent = self.root / "absent"
        for kind in ("SubagentStart", "SubagentStop", "UserPromptSubmit", "Stop"):
            self.assertEqual(hook.output_for({"hook_event_name": kind, "source": "startup"}, absent), {})

    def test_missing_empty_and_oversize_files_report_without_content(self):
        event = {"hook_event_name": "SessionStart", "source": "startup"}
        for value in (None, b"", b"x" * (hook.MAX_BYTES + 1), b"\xff"):
            file = self.root / "invalid.md"
            if value is not None:
                file.write_bytes(value)
            result = hook.output_for(event, file)
            self.assertIs(result["continue"], False)
            self.assertNotIn("additionalContext", json.dumps(result))

    def test_install_preserves_other_hooks_and_agents_and_is_idempotent(self):
        home = self.root / "codex"
        home.mkdir()
        (home / "AGENTS.md").write_text("EXISTING_SHARED_RULES")
        existing = {"description": "owner config", "hooks": {
            "SessionStart": [{"hooks": [{"type": "command", "command": "echo existing"}]}],
            "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo recall"}]}]}}
        (home / "hooks.json").write_text(json.dumps(existing))
        plan = installer.install(self.note, home)
        self.assertFalse((home / "worker-routing").exists())
        result = installer.install(self.note, home, True)
        actual = json.loads((home / "hooks.json").read_text())
        self.assertEqual(actual["description"], existing["description"])
        self.assertEqual(actual["hooks"]["UserPromptSubmit"], existing["hooks"]["UserPromptSubmit"])
        self.assertEqual(actual["hooks"]["SessionStart"][0], existing["hooks"]["SessionStart"][0])
        self.assertEqual(actual["hooks"]["SessionStart"][1], plan["hook"])
        self.assertEqual((home / "AGENTS.md").read_text(), "EXISTING_SHARED_RULES")
        self.assertEqual(json.loads((Path(result["backup"]) / "hooks.json").read_text()), existing)
        self.assertFalse(installer.install(self.note, home, True)["changed"])


if __name__ == "__main__":
    unittest.main()
