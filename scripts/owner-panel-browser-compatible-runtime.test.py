import importlib.util
from pathlib import Path
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "browser_compat_runtime", ROOT / "scripts/owner-panel-browser-compatible-runtime.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class BrowserCompatibleRuntimeTest(unittest.TestCase):
    def test_origin_request_gets_browser_user_agent(self):
        request = urllib.request.Request(
            "https://control.rozkalns.net/api/health", method="GET")
        M.apply_runtime_user_agent(request)
        headers = {name.casefold(): value for name, value in request.header_items()}
        self.assertEqual(headers["user-agent"], M.BROWSER_USER_AGENT)
        self.assertNotIn("cf-access-client-secret", headers)

    def test_non_origin_request_is_not_modified(self):
        request = urllib.request.Request(
            "https://api.cloudflare.com/client/v4/accounts/example", method="GET")
        M.apply_runtime_user_agent(request)
        headers = {name.casefold(): value for name, value in request.header_items()}
        self.assertNotIn("user-agent", headers)

    def test_existing_user_agent_is_preserved(self):
        request = urllib.request.Request(
            "https://control.rozkalns.net/",
            headers={"User-Agent": "synthetic-existing-agent"},
            method="GET",
        )
        M.apply_runtime_user_agent(request)
        headers = {name.casefold(): value for name, value in request.header_items()}
        self.assertEqual(headers["user-agent"], "synthetic-existing-agent")

    def test_target_allowlist_is_exact(self):
        for target in M.ALLOWED_RELATIVE_TARGETS:
            resolved = M.resolve_target(target)
            self.assertEqual(resolved.parent, ROOT / "scripts")
        for target in (
            "scripts/owner-panel-access-secret-rotate.py",
            "../outside.py",
            "/tmp/outside.py",
        ):
            with self.assertRaisesRegex(ValueError, "TARGET_NOT_ALLOWLISTED"):
                M.resolve_target(target)

    def test_invalid_cli_shape_fails_closed(self):
        self.assertEqual(M.main(["runner"]), 2)
        self.assertEqual(M.main(["runner", "scripts/owner-panel-access-secret-rotate.py"]), 2)


if __name__ == "__main__":
    unittest.main()
