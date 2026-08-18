#!/usr/bin/env python3
"""Opt in to workspace-scoped autonomous Codex development permissions."""

import argparse
import datetime as dt
import os
import shlex
import tempfile
import tomllib
from pathlib import Path


TOP_LEVEL = '''approval_policy = "never"
default_permissions = "autonomous-dev"
'''
PROFILE = '''[permissions.autonomous-dev]
description = "Autonomous coding inside the active workspace."
extends = ":workspace"

[permissions.autonomous-dev.filesystem.":workspace_roots"]
".git" = "write"

[permissions.autonomous-dev.network]
enabled = true

[permissions.autonomous-dev.network.domains]
"*" = "allow"
'''


def atomic_write(path: Path, data: bytes) -> None:
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, path.stat().st_mode if path.exists() else 0o600)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def configure(path: Path) -> tuple[Path | None, bool]:
    original = path.read_text() if path.exists() else ""
    parsed = tomllib.loads(original) if original else {}
    legacy = {key for key in ("sandbox_mode", "sandbox_workspace_write") if key in parsed}
    if legacy:
        raise SystemExit("remove legacy settings before opting in: " + ", ".join(sorted(legacy)))
    if original.startswith(TOP_LEVEL) and PROFILE.strip() in original:
        return None, path.exists()
    if "permissions" in parsed:
        raise SystemExit("existing permission profiles found; refusing an automatic merge")
    if parsed.get("default_permissions") not in (None, "autonomous-dev"):
        raise SystemExit("conflicting default_permissions; refusing to overwrite")
    if parsed.get("approval_policy") not in (None, "never"):
        raise SystemExit("conflicting approval_policy; refusing to overwrite")

    merged = TOP_LEVEL.rstrip() + "\n\n" + original.lstrip("\n")
    merged = merged.rstrip() + "\n\n" + PROFILE
    tomllib.loads(merged)
    if merged == original:
        return None, path.exists()

    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(path.name + ".backup-autonomous-dev-" + stamp)
    if path.exists():
        atomic_write(backup, path.read_bytes())
    else:
        backup = None
    atomic_write(path, merged.encode())
    return backup, original != ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", type=Path, default=Path.home() / ".codex/config.toml")
    args = parser.parse_args()
    backup, existed = configure(args.path)
    if backup is None and existed:
        print("already configured")
    else:
        print(f"configured {args.path}")
        if backup is None:
            print("backup: none (the config did not previously exist)")
            print(f"rollback: rm {shlex.quote(str(args.path))}")
        else:
            print(f"backup: {backup}")
            print(
                "rollback: cp "
                + shlex.quote(str(backup))
                + " "
                + shlex.quote(str(args.path))
            )


if __name__ == "__main__":
    main()
