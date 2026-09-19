import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "browser_compat_runtime", ROOT / "scripts/owner-panel-browser-compatible-runtime.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
COMPOSED_SPEC = importlib.util.spec_from_file_location(
    "composed_preflight", ROOT / "scripts/owner-panel-readonly-preflight-composed.py")
C = importlib.util.module_from_spec(COMPOSED_SPEC)
COMPOSED_SPEC.loader.exec_module(C)
VERSION = "11111111-1111-1111-1111-111111111111"
DEPLOYMENT = "22222222-2222-4222-8222-222222222222"
SOURCE_SHA = "a" * 40


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
        self.assertEqual(
            M.ALLOWED_RELATIVE_TARGETS,
            frozenset(("scripts/owner-panel-readonly-preflight.py",)),
        )
        self.assertEqual(
            M.resolve_target("scripts/owner-panel-readonly-preflight.py").parent,
            ROOT / "scripts",
        )
        for target in (
            "scripts/owner-panel-health403-detail.py",
            "scripts/owner-panel-health403-credential-effect.py",
            "scripts/owner-panel-access-secret-rotate.py",
            "../outside.py",
            "/tmp/outside.py",
        ):
            with self.assertRaisesRegex(ValueError, "TARGET_NOT_ALLOWLISTED"):
                M.resolve_target(target)

    def test_invalid_cli_shape_fails_closed(self):
        self.assertEqual(M.main(["runner"]), 2)
        self.assertEqual(M.main(["runner", "scripts/owner-panel-access-secret-rotate.py"]), 2)


class ComposedInventoryTest(unittest.TestCase):
    def env(self):
        return {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF_NAME": "main",
            "GITHUB_SHA": SOURCE_SHA,
            "GITHUB_TOKEN": "synthetic-github",
            "CLOUDFLARE_WORKERS_READ_TOKEN": "synthetic-workers",
            "CLOUDFLARE_D1_READ_TOKEN": "synthetic-d1",
            "CLOUDFLARE_ACCESS_READ_TOKEN": "synthetic-access-read",
            "CONTROL_ACCESS_CLIENT_ID": "synthetic-client-id",
            "CONTROL_ACCESS_CLIENT_SECRET": "synthetic-client-secret",
        }

    def baseline_receipt(self):
        return {
            "schema_version": 1,
            "source_sha": SOURCE_SHA,
            "ci_run_id": 1,
            "observed_at": "synthetic",
            "deployment": DEPLOYMENT,
            "version": VERSION,
            "bindings": {},
            "d1": {},
            "campaign_counts": {},
            "health": "NOT_PROVEN_ACCESS_CREDENTIALS_ABSENT",
            "ui": "NOT_PROVEN_ACCESS_CREDENTIALS_ABSENT",
            "access_owner_policy": "NOT_PROVEN_BY_BINDING_MATCH",
            "github_read_credential_usability": "NOT_PROVEN_BY_SECRET_METADATA",
            "retry_ci": "DISABLED_SEPARATE_PERMISSION_GATE",
            "production_mutations": 0,
            "activation_ready": False,
            "next_gate": "REVIEW_READONLY_EVIDENCE_AND_BOUND_LIVE_SCOPE",
        }

    def test_health_is_proven_without_service_token_request_to_human_ui(self):
        env = self.env()
        calls = []

        def read(url, token, **kwargs):
            calls.append((url, kwargs))
            self.assertNotEqual(url, C.P.ORIGIN + "/")
            if url == C.P.GH + "/branches/main":
                return {"commit": {"sha": SOURCE_SHA}}
            if url == C.P.CF + "/workers/scripts/" + C.P.WORKER + "/deployments":
                return {"success": True, "result": {"deployments": [{
                    "id": DEPLOYMENT,
                    "versions": [{"version_id": VERSION, "percentage": 100}],
                }]}}
            self.fail("unexpected final revalidation request: " + url)

        health_calls = []

        def health_read(url, token, **kwargs):
            health_calls.append((url, kwargs))
            return {"status": "ok", "service": C.P.WORKER, "workerVersion": VERSION}

        with patch.object(C.P, "run", return_value=self.baseline_receipt()) as run_mock:
            receipt = C.composed_inventory(env, read=read, health_read=health_read)

        base_env = run_mock.call_args.args[0]
        self.assertNotIn("CONTROL_ACCESS_CLIENT_ID", base_env)
        self.assertNotIn("CONTROL_ACCESS_CLIENT_SECRET", base_env)
        self.assertEqual(len(health_calls), 1)
        self.assertEqual(health_calls[0][0], C.P.ORIGIN + "/api/health")
        self.assertEqual(
            health_calls[0][1]["access"],
            (env["CONTROL_ACCESS_CLIENT_ID"], env["CONTROL_ACCESS_CLIENT_SECRET"]),
        )
        self.assertEqual(receipt["health"], "MATCH")
        self.assertEqual(receipt["ui"], C.UI_RESULT)
        self.assertFalse(receipt["activation_ready"])
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertEqual(receipt["next_gate"], "HUMAN_UI_ACCESS_REMAINS_SEPARATE")
        self.assertEqual([url for url, _ in calls], [
            C.P.GH + "/branches/main",
            C.P.CF + "/workers/scripts/" + C.P.WORKER + "/deployments",
        ])

    def test_health_identity_mismatch_fails_closed(self):
        env = self.env()
        with patch.object(C.P, "run", return_value=self.baseline_receipt()):
            with self.assertRaisesRegex(ValueError, "HEALTH_IDENTITY_INVALID"):
                C.composed_inventory(
                    env,
                    read=lambda *_args, **_kwargs: self.fail("final revalidation must not run"),
                    health_read=lambda *_args, **_kwargs: {
                        "status": "ok", "service": C.P.WORKER, "workerVersion": "wrong"
                    },
                )

    def test_missing_service_credential_fails_before_inventory(self):
        env = self.env()
        del env["CONTROL_ACCESS_CLIENT_SECRET"]
        with patch.object(C.P, "run") as run_mock:
            with self.assertRaisesRegex(ValueError, "REQUIRED_READ_CREDENTIAL_ABSENT"):
                C.composed_inventory(env)
        run_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
