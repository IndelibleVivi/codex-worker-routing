#!/usr/bin/env python3
"""Inject an operator-owned local instruction file into root SessionStart only."""

import argparse
import json
from pathlib import Path
import sys

MAX_BYTES = 65536
MARKER = "worker-routing-main-context/v1"


def output_for(event, instructions):
    if event.get("hook_event_name") != "SessionStart":
        return {}
    if event.get("source") not in ("startup", "resume", "clear", "compact"):
        return {}
    try:
        with instructions.open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
        if not data.strip() or len(data) > MAX_BYTES:
            raise ValueError("instructions must contain 1–65536 UTF-8 bytes")
        content = data.decode("utf-8")
    except (OSError, UnicodeError, ValueError):
        # Never echo a private file or its contents into an error message.
        return {
            "continue": False,
            "stopReason": "Main-session instructions could not be loaded completely.",
            "systemMessage": "Check the Worker Routing main-session file before continuing.",
        }
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                f"{MARKER} begin\n"
                "The following local instructions apply to this main session. "
                "Keep them out of worker handoffs and conversation forks.\n\n"
                + content
                + f"\n{MARKER} end"
            ),
        }
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instructions", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(output_for(json.load(sys.stdin), args.instructions), ensure_ascii=False))


if __name__ == "__main__":
    main()
