import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "integrations/main-session" / "install.py"
SOURCE = ROOT / "integrations/main-session" / "main_session.py"


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "integrations/main-session" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def snapshot(root):
    """Non-following description of a tree, for zero-mutation comparisons."""
    entries = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in list(dirnames) + list(filenames):
            path = Path(dirpath) / name
            info = os.lstat(path)
            entries[str(path.relative_to(root))] = (
                stat.S_IFMT(info.st_mode),
                info.st_ino,
                info.st_nlink,
                info.st_mtime_ns,
                os.readlink(path) if stat.S_ISLNK(info.st_mode) else None,
                path.read_bytes() if stat.S_ISREG(info.st_mode) else None,
            )
    return entries


def assert_inside_temp(test, home):
    """Guard: the installer is only ever aimed at this test's own temporary tree."""
    target = Path(os.path.abspath(home))
    test.assertTrue(target.is_relative_to(test.root),
                    f"{target} is outside the test temp root {test.root}")


def canonical_home(home):
    """The path the installer reports: lexical absolute, ancestors canonicalized."""
    path = Path(os.path.abspath(home))
    return path.parent.resolve() / path.name


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
        assert_inside_temp(self, home)
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


class ManagedOutputTopologyTests(unittest.TestCase):
    """Managed outputs must be absent or plain single-link files/dirs, fail closed."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.note = self.root / "main.md"
        self.content = "PRIVATE_START\n" + "合成的主会话说明。\n" * 800 + "PRIVATE_END\n"
        self.note.write_text(self.content)
        self.leaks = (str(self.note), str(self.note.resolve()), "PRIVATE_START")

    def codex_home(self):
        home = self.root / "codex"
        home.mkdir(exist_ok=True)
        return home

    def assert_zero_mutation(self, before):
        self.assertEqual(snapshot(self.root), before)

    def assert_topology_failure(self, home, relative, kind):
        """Both modes must reject the topology before reading or writing it."""
        assert_inside_temp(self, home)
        before = snapshot(self.root)
        expected = canonical_home(home)
        if relative:
            expected = expected / relative
        for apply in (False, True):
            with self.assertRaises(ValueError) as caught:
                installer.install(self.note, home, apply)
            message = str(caught.exception)
            self.assertIn(str(expected), message)
            self.assertIn(kind, message)
            for leak in self.leaks:
                self.assertNotIn(leak, message)
        self.assert_zero_mutation(before)

    def run_installer(self, home, *extra):
        assert_inside_temp(self, home)
        return subprocess.run(
            [sys.executable, str(INSTALLER), "--instructions", str(self.note),
             "--codex-home", str(home), *extra],
            capture_output=True, text=True, timeout=3)

    def test_symlinked_codex_home_fails_closed(self):
        real = self.root / "real-codex"
        real.mkdir()
        home = self.root / "codex"
        os.symlink(real, home)
        self.leaks += (str(real),)
        self.assert_topology_failure(home, None, "symlink")

    def test_dangling_codex_home_symlink_fails_closed(self):
        home = self.root / "codex"
        missing = self.root / "missing-codex"
        os.symlink(missing, home)
        self.leaks += (str(missing),)
        self.assert_topology_failure(home, None, "symlink")

    def test_codex_home_regular_file_fails_closed(self):
        home = self.root / "codex"
        home.write_text("not a directory")
        self.assert_topology_failure(home, None, "regular file")

    def test_fifo_codex_home_fails_without_hanging(self):
        home = self.root / "codex"
        os.mkfifo(home)
        before = snapshot(self.root)
        for extra in ((), ("--apply",)):
            result = self.run_installer(home, *extra)
            self.assertNotEqual(result.returncode, 0)
            output = result.stdout + result.stderr
            self.assertIn(str(canonical_home(home)), output)
            self.assertIn("FIFO", output)
            for leak in self.leaks:
                self.assertNotIn(leak, output)
        self.assert_zero_mutation(before)

    def test_ancestor_symlink_alias_reuses_one_managed_definition(self):
        real_home = self.root / "real" / "codex"
        real_home.mkdir(parents=True)
        alias = self.root / "alias"
        os.symlink(self.root / "real", alias)
        assert_inside_temp(self, alias / "codex")
        first = installer.install(self.note, real_home, True)
        plan = installer.install(self.note, alias / "codex")
        self.assertFalse(plan["changed"])
        self.assertEqual(plan["hooks_file"], first["hooks_file"])
        applied = installer.install(self.note, alias / "codex", True)
        self.assertFalse(applied["changed"])
        self.assertEqual(applied["hooks_file"], first["hooks_file"])
        self.assertEqual(applied["hook"], first["hook"])
        command = applied["hook"]["hooks"][0]["command"]
        self.assertNotIn(str(alias), command)
        self.assertIn(str(real_home.resolve()), command)
        hooks = json.loads((real_home / "hooks.json").read_text())
        self.assertEqual(hooks["hooks"]["SessionStart"], [first["hook"]])
        backups = real_home / "worker-routing" / "backups"
        self.assertEqual(len(list(backups.iterdir())), 1)

    def test_symlinked_hooks_json_fails_closed(self):
        home = self.codex_home()
        os.symlink(self.note, home / "hooks.json")
        self.assert_topology_failure(home, "hooks.json", "symlink")

    def test_dangling_hooks_json_symlink_fails_closed(self):
        home = self.codex_home()
        missing = self.root / "missing.json"
        os.symlink(missing, home / "hooks.json")
        self.leaks += (str(missing),)
        self.assert_topology_failure(home, "hooks.json", "symlink")

    def test_worker_routing_directory_symlink_fails_closed(self):
        home = self.codex_home()
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, home / "worker-routing")
        self.leaks += (str(elsewhere),)
        self.assert_topology_failure(home, "worker-routing", "symlink")

    def test_symlinked_runtime_fails_closed(self):
        home = self.codex_home()
        (home / "worker-routing").mkdir()
        os.symlink(self.note, home / "worker-routing" / "main_session.py")
        self.assert_topology_failure(home, "worker-routing/main_session.py", "symlink")

    def test_dangling_runtime_symlink_fails_closed(self):
        home = self.codex_home()
        (home / "worker-routing").mkdir()
        missing = self.root / "missing.py"
        os.symlink(missing, home / "worker-routing" / "main_session.py")
        self.leaks += (str(missing),)
        self.assert_topology_failure(home, "worker-routing/main_session.py", "symlink")

    def test_backups_symlink_fails_closed(self):
        home = self.codex_home()
        (home / "worker-routing").mkdir()
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, home / "worker-routing" / "backups")
        self.leaks += (str(elsewhere),)
        self.assert_topology_failure(home, "worker-routing/backups", "symlink")

    def test_hardlinked_hooks_json_fails_closed(self):
        home = self.codex_home()
        hooks = home / "hooks.json"
        hooks.write_text("{}")
        os.link(hooks, self.root / "hooks-alias.json")
        self.assert_topology_failure(home, "hooks.json", "hardlink")

    def test_hardlinked_runtime_fails_closed(self):
        home = self.codex_home()
        (home / "worker-routing").mkdir()
        runtime = home / "worker-routing" / "main_session.py"
        runtime.write_bytes(b"# previous runtime\n")
        os.link(runtime, self.root / "runtime-alias.py")
        self.assert_topology_failure(home, "worker-routing/main_session.py", "hardlink")

    def test_wrong_type_managed_outputs_fail_closed(self):
        home = self.codex_home()
        (home / "hooks.json").mkdir()
        self.assert_topology_failure(home, "hooks.json", "directory")

    def test_worker_routing_regular_file_fails_closed(self):
        home = self.codex_home()
        (home / "worker-routing").write_text("not a directory")
        self.assert_topology_failure(home, "worker-routing", "regular file")

    def test_socket_managed_output_fails_closed(self):
        home = self.codex_home()
        target = home / "hooks.json"
        if len(os.fsencode(target)) > 100:
            self.skipTest("AF_UNIX path too long for this temporary directory")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(str(target))
        self.assert_topology_failure(home, "hooks.json", "socket")

    def test_fifo_hooks_json_fails_without_hanging(self):
        home = self.codex_home()
        os.mkfifo(home / "hooks.json")
        before = snapshot(self.root)
        for extra in ((), ("--apply",)):
            result = self.run_installer(home, *extra)
            self.assertNotEqual(result.returncode, 0)
            output = result.stdout + result.stderr
            self.assertIn("hooks.json", output)
            self.assertIn("FIFO", output)
            for leak in self.leaks:
                self.assertNotIn(leak, output)
        self.assert_zero_mutation(before)

    def test_fifo_runtime_fails_without_hanging(self):
        home = self.codex_home()
        (home / "worker-routing").mkdir()
        os.mkfifo(home / "worker-routing" / "main_session.py")
        before = snapshot(self.root)
        result = self.run_installer(home, "--apply")
        self.assertNotEqual(result.returncode, 0)
        output = result.stdout + result.stderr
        self.assertIn("main_session.py", output)
        self.assertIn("FIFO", output)
        for leak in self.leaks:
            self.assertNotIn(leak, output)
        self.assert_zero_mutation(before)

    def test_dry_run_never_mutates(self):
        home = self.codex_home()
        assert_inside_temp(self, home)
        (home / "worker-routing").mkdir()
        (home / "worker-routing" / "main_session.py").write_bytes(b"# previous runtime\n")
        (home / "hooks.json").write_text(json.dumps({"hooks": {"SessionStart": []}}))
        before = snapshot(self.root)
        plan = installer.install(self.note, home)
        self.assert_zero_mutation(before)
        self.assertTrue(plan["changed"])
        self.assertFalse((home / "worker-routing" / "backups").exists())

    def test_clean_first_install_then_idempotent(self):
        home = self.root / "codex"
        assert_inside_temp(self, home)
        result = installer.install(self.note, home, True)
        hooks = json.loads((home / "hooks.json").read_text())
        self.assertEqual(hooks["hooks"]["SessionStart"], [result["hook"]])
        runtime = home / "worker-routing" / "main_session.py"
        self.assertEqual(runtime.read_bytes(), SOURCE.read_bytes())
        self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o600)
        backup = Path(result["backup"])
        self.assertEqual(backup.parent,
                         canonical_home(home) / "worker-routing" / "backups")
        self.assertEqual(list(backup.iterdir()), [])
        self.assertFalse(installer.install(self.note, home, True)["changed"])

    def test_existing_regular_files_are_backed_up_before_replacement(self):
        home = self.codex_home()
        assert_inside_temp(self, home)
        (home / "worker-routing").mkdir()
        previous_runtime = b"# previous runtime\n"
        (home / "worker-routing" / "main_session.py").write_bytes(previous_runtime)
        existing = {"description": "owner config", "hooks": {"SessionStart": [
            {"hooks": [{"type": "command", "command": "echo existing"}]}]}}
        (home / "hooks.json").write_text(json.dumps(existing))
        result = installer.install(self.note, home, True)
        backup = Path(result["backup"])
        self.assertEqual(json.loads((backup / "hooks.json").read_text()), existing)
        self.assertEqual((backup / "main_session.py").read_bytes(), previous_runtime)
        merged = json.loads((home / "hooks.json").read_text())
        self.assertEqual(merged["description"], existing["description"])
        self.assertEqual(merged["hooks"]["SessionStart"][0], existing["hooks"]["SessionStart"][0])
        self.assertEqual(merged["hooks"]["SessionStart"][1], result["hook"])
        runtime = home / "worker-routing" / "main_session.py"
        self.assertEqual(runtime.read_bytes(), SOURCE.read_bytes())
        self.assertFalse(installer.install(self.note, home, True)["changed"])


if __name__ == "__main__":
    unittest.main()
