#!/usr/bin/env python3
"""Prepare or install a root-only context hook; never edit AGENTS or hook trust."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile


def _managed_state(path):
    """Classify a managed output without following links; None when it is absent."""
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as error:
        raise ValueError(
            f"managed path could not be inspected [{error.__class__.__name__}]: {path}"
        ) from error
    mode = info.st_mode
    if stat.S_ISLNK(mode):
        return "symlink", info
    if stat.S_ISDIR(mode):
        return "directory", info
    if stat.S_ISREG(mode):
        return "regular file", info
    if stat.S_ISFIFO(mode):
        return "FIFO", info
    if stat.S_ISSOCK(mode):
        return "socket", info
    if stat.S_ISCHR(mode):
        return "character device", info
    if stat.S_ISBLK(mode):
        return "block device", info
    return "special file", info


def _require_single_link_regular(path, state):
    """True when present; fail closed on anything but a single-link regular file."""
    if state is None:
        return False
    kind, info = state
    if kind == "regular file" and info.st_nlink == 1:
        return True
    found = "hardlinked regular file" if kind == "regular file" else kind
    raise ValueError(
        f"managed path must be absent or a single-link regular file; found {found}: {path}"
    )


def _require_directory(path, state):
    """True when present; fail closed on anything but a real directory."""
    if state is None:
        return False
    kind, _info = state
    if kind == "directory":
        return True
    raise ValueError(f"managed path must be absent or a real directory; found {kind}: {path}")


def _read_managed(path):
    """Read a managed output that inspection already confirmed as a regular file."""
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        return stream.read()


def _publish(path, data, mode=0o600):
    """Replace a managed output through same-directory staging so it never lands partial."""
    descriptor, staging = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp",
                                           dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.chmod(staging, mode)
        os.replace(staging, path)
    except BaseException:
        try:
            os.unlink(staging)
        except OSError:
            pass
        raise


def install(instructions, codex_home, apply=False):
    instructions = instructions.expanduser().resolve(strict=True)
    if not instructions.is_file():
        raise ValueError("instructions must be a regular file")
    data = instructions.read_bytes()
    if not data.strip() or len(data) > 65536:
        raise ValueError("instructions must contain 1–65536 UTF-8 bytes")
    data.decode("utf-8")
    # Normalize to a lexical absolute path, then canonicalize only the parent chain. An
    # ancestor symlink therefore keeps the canonical command path that older resolved
    # installs recorded, while a symlinked or dangling CODEX_HOME itself stays unfollowed
    # and is rejected by the preflight below.
    lexical_home = Path(os.path.abspath(codex_home.expanduser()))
    codex_home = lexical_home.parent.resolve() / lexical_home.name
    routing_dir = codex_home / "worker-routing"
    runtime = routing_dir / "main_session.py"
    hooks_path = codex_home / "hooks.json"
    backup_root = routing_dir / "backups"
    # Inspect the whole managed topology with lstat before this run reads or writes any of
    # it, CODEX_HOME first. Links, hardlinks, FIFOs, sockets, devices, and type mismatches
    # fail closed here so neither a dry run nor an apply follows or mutates through one.
    _require_directory(codex_home, _managed_state(codex_home))
    hooks_present = _require_single_link_regular(hooks_path, _managed_state(hooks_path))
    _require_directory(routing_dir, _managed_state(routing_dir))
    runtime_present = _require_single_link_regular(runtime, _managed_state(runtime))
    _require_directory(backup_root, _managed_state(backup_root))
    source = Path(__file__).with_name("main_session.py")
    source_bytes = source.read_bytes()
    command = shlex.join([sys.executable, str(runtime), "--instructions", str(instructions)])
    definition = {
        "matcher": "^(startup|resume|clear|compact)$",
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": 3,
            "statusMessage": "Loading main-session instructions",
            "additionalContextLimit": 0,
        }],
    }
    previous_hooks = _read_managed(hooks_path) if hooks_present else None
    previous_runtime = _read_managed(runtime) if runtime_present else None
    config = json.loads(previous_hooks.decode("utf-8")) if hooks_present else {}
    groups = config.setdefault("hooks", {}).setdefault("SessionStart", [])
    retained = []
    for group in groups:
        others = [h for h in group.get("hooks", [])
                  if str(runtime) not in shlex.split(h.get("command", ""))]
        if others:
            retained.append(dict(group, hooks=others))
    config["hooks"]["SessionStart"] = retained + [definition]
    serialized = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    changed = (previous_hooks != serialized.encode("utf-8")
               or previous_runtime != source_bytes)
    result = {"applied": apply, "changed": changed, "hook": definition,
              "instructions": str(instructions), "hooks_file": str(hooks_path),
              "trust": "Review the exact definition in Codex /hooks before removing old instructions."}
    if not apply or not changed:
        return result
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-")
    backup = Path(tempfile.mkdtemp(prefix=stamp, dir=backup_root))
    for name, previous in (("hooks.json", previous_hooks),
                           ("main_session.py", previous_runtime)):
        if previous is not None:
            target = backup / name
            target.write_bytes(previous)
            target.chmod(0o600)
    _publish(runtime, source_bytes)
    # Replace the complete JSON atomically after preserving the prior definition.
    _publish(hooks_path, serialized.encode("utf-8"))
    result["backup"] = str(backup)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instructions", type=Path, required=True)
    parser.add_argument("--codex-home", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", "~/.codex")))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(install(args.instructions, args.codex_home, args.apply), indent=2))


if __name__ == "__main__":
    main()
