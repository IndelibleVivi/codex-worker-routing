#!/usr/bin/env python3
"""Prepare or install a root-only context hook; never edit AGENTS or hook trust."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile


def install(instructions, codex_home, apply=False):
    instructions = instructions.expanduser().resolve(strict=True)
    if not instructions.is_file():
        raise ValueError("instructions must be a regular file")
    data = instructions.read_bytes()
    if not data.strip() or len(data) > 65536:
        raise ValueError("instructions must contain 1–65536 UTF-8 bytes")
    data.decode("utf-8")
    codex_home = codex_home.expanduser().resolve()
    runtime = codex_home / "worker-routing" / "main_session.py"
    hooks_path = codex_home / "hooks.json"
    config = json.loads(hooks_path.read_text()) if hooks_path.exists() else {}
    source = Path(__file__).with_name("main_session.py")
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
    groups = config.setdefault("hooks", {}).setdefault("SessionStart", [])
    retained = []
    for group in groups:
        others = [h for h in group.get("hooks", [])
                  if str(runtime) not in shlex.split(h.get("command", ""))]
        if others:
            retained.append(dict(group, hooks=others))
    config["hooks"]["SessionStart"] = retained + [definition]
    serialized = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    changed = (not hooks_path.exists() or hooks_path.read_text() != serialized
               or not runtime.exists() or runtime.read_bytes() != source.read_bytes())
    result = {"applied": apply, "changed": changed, "hook": definition,
              "instructions": str(instructions), "hooks_file": str(hooks_path),
              "trust": "Review the exact definition in Codex /hooks before removing old instructions."}
    if not apply or not changed:
        return result
    backup_root = runtime.parent / "backups"
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-")
    backup = Path(tempfile.mkdtemp(prefix=stamp, dir=backup_root))
    for current in (hooks_path, runtime):
        if current.exists():
            target = backup / current.name
            shutil.copyfile(current, target)
            target.chmod(0o600)
    runtime.write_bytes(source.read_bytes())
    runtime.chmod(0o600)
    # Replace the complete JSON atomically after preserving the prior definition.
    handle, staging = tempfile.mkstemp(prefix=".hooks-", suffix=".json", dir=codex_home)
    with os.fdopen(handle, "w") as stream:
        stream.write(serialized)
    os.replace(staging, hooks_path)
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
