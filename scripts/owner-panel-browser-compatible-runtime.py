#!/usr/bin/env python3
"""Run allowlisted owner-panel runtime diagnostics with a browser-compatible User-Agent."""
import runpy
import socket
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN_HOST = "control.rozkalns.net"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)
ALLOWED_RELATIVE_TARGETS = frozenset((
    "scripts/owner-panel-readonly-preflight.py",
    "scripts/owner-panel-health403-detail.py",
    "scripts/owner-panel-health403-credential-effect.py",
))
_ORIGINAL_OPEN = urllib.request.OpenerDirector.open


def apply_runtime_user_agent(fullurl):
    if not isinstance(fullurl, urllib.request.Request):
        return fullurl
    host = urllib.parse.urlparse(fullurl.full_url).hostname
    if host != ORIGIN_HOST:
        return fullurl
    if any(name.casefold() == "user-agent" for name, _ in fullurl.header_items()):
        return fullurl
    fullurl.add_unredirected_header("User-Agent", BROWSER_USER_AGENT)
    return fullurl


def browser_compatible_open(self, fullurl, data=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT):
    return _ORIGINAL_OPEN(self, apply_runtime_user_agent(fullurl), data, timeout)


def resolve_target(value):
    if value not in ALLOWED_RELATIVE_TARGETS:
        raise ValueError("TARGET_NOT_ALLOWLISTED")
    target = (ROOT / value).resolve()
    if target.parent != ROOT / "scripts" or not target.is_file():
        raise ValueError("TARGET_NOT_ALLOWLISTED")
    return target


def main(argv):
    if len(argv) != 2:
        return 2
    try:
        target = resolve_target(argv[1])
    except (OSError, ValueError):
        return 2
    urllib.request.OpenerDirector.open = browser_compatible_open
    previous_argv = sys.argv
    sys.argv = [str(target)]
    try:
        try:
            runpy.run_path(str(target), run_name="__main__")
        except SystemExit as exc:
            return exc.code if isinstance(exc.code, int) else 1
        return 0
    finally:
        sys.argv = previous_argv
        urllib.request.OpenerDirector.open = _ORIGINAL_OPEN


if __name__ == "__main__":
    sys.exit(main(sys.argv))
