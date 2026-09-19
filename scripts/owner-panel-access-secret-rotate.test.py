import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "access_secret_rotate", ROOT / "scripts/owner-panel-access-secret-rotate.py"
)
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)

TOKEN_ID = "44444444-4444-4444-8444-444444444444"
CLIENT_ID = "synthetic-client-id"
NEW_SECRET = "cfast_" + ("A" * 48)
NOW = datetime.datetime(2026, 9, 19, 8, 0, 0, tzinfo=datetime.timezone.utc)


class RotationTest(unittest.TestCase):
    def env(self, tempdir, **overrides):
        value = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF_NAME": "main",
            "GITHUB_SHA": "a" * 40,
            "EXPECTED_MAIN_SHA": "a" * 40,
            "CLOUDFLARE_ACCESS_READ_TOKEN": "synthetic-read-token",
            "CLOUDFLARE_ACCESS_WRITE_TOKEN": "synthetic-write-token",
            "CONTROL_ACCESS_CLIENT_ID": CLIENT_ID,
            "RUNNER_TEMP": tempdir,
            "ROTATION_OUTPUT_FILE": str(Path(tempdir) / "rotation.json"),
        }
        value.update(overrides)
        return value

    def sender(self, *, enabled=True, post_error=None, rotate_result=None):
        calls = []

        def send(request):
            calls.append(request)
            if request.method == "GET":
                self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-read-token")
                self.assertEqual(
                    request.full_url,
                    R.BASE + "?per_page=100&page=1",
                )
                return {
                    "success": True,
                    "result": [{
                        "id": TOKEN_ID,
                        "client_id": CLIENT_ID,
                        "enabled": enabled,
                    }],
                }
            if request.method == "POST":
                self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-write-token")
                self.assertEqual(request.full_url, R.BASE + f"/{TOKEN_ID}/rotate")
                if post_error is not None:
                    raise post_error
                body = json.loads(request.data.decode("utf-8"))
                self.assertEqual(
                    body,
                    {"previous_client_secret_expires_at": "2026-09-19T09:00:00Z"},
                )
                return rotate_result or {
                    "success": True,
                    "result": {
                        "id": TOKEN_ID,
                        "client_id": CLIENT_ID,
                        "client_secret": NEW_SECRET,
                    },
                }
            self.fail("Unexpected method: " + request.method)

        return calls, send

    def test_success_is_exact_target_one_hour_and_private(self):
        with tempfile.TemporaryDirectory() as tempdir:
            calls, send = self.sender()
            receipt = R.run(self.env(tempdir), send=send, now=NOW)
            self.assertEqual(receipt["detail"], "SELECTED_ACCESS_SERVICE_TOKEN_SECRET_ROTATED")
            self.assertEqual(receipt["previous_secret_grace"], "PT1H")
            self.assertEqual(receipt["previous_client_secret_expires_at"], "2026-09-19T09:00:00Z")
            self.assertEqual(receipt["production_mutations"], 1)
            self.assertTrue(receipt["client_id_unchanged"])
            self.assertEqual([request.method for request in calls], ["GET", "POST"])
            payload_path = Path(tempdir) / "rotation.json"
            self.assertEqual(payload_path.stat().st_mode & 0o777, 0o600)
            payload = json.loads(payload_path.read_text())
            self.assertEqual(payload, {"client_id": CLIENT_ID, "client_secret": NEW_SECRET})
            rendered = json.dumps(receipt)
            for private in (
                NEW_SECRET,
                "synthetic-read-token",
                "synthetic-write-token",
                TOKEN_ID,
                CLIENT_ID,
            ):
                self.assertNotIn(private, rendered)

    def test_contract_drift_stops_before_network(self):
        with tempfile.TemporaryDirectory() as tempdir:
            calls = []
            receipt = R.run(
                self.env(tempdir, EXPECTED_MAIN_SHA="b" * 40),
                send=lambda request: calls.append(request),
                now=NOW,
            )
            self.assertEqual(receipt["reason"], "EXACT_MAIN_DISPATCH_REQUIRED")
            self.assertEqual(receipt["production_mutations"], 0)
            self.assertEqual(calls, [])

    def test_disabled_target_stops_before_post(self):
        with tempfile.TemporaryDirectory() as tempdir:
            calls, send = self.sender(enabled=False)
            receipt = R.run(self.env(tempdir), send=send, now=NOW)
            self.assertEqual(receipt["reason"], "ROTATION_PREFLIGHT_FAILED")
            self.assertEqual(receipt["production_mutations"], 0)
            self.assertEqual([request.method for request in calls], ["GET"])
            self.assertFalse((Path(tempdir) / "rotation.json").exists())

    def test_post_error_is_uncertain_and_never_retries(self):
        with tempfile.TemporaryDirectory() as tempdir:
            error = urllib.error.HTTPError(
                R.BASE + f"/{TOKEN_ID}/rotate", 403, "private-provider-error", {}, None
            )
            calls, send = self.sender(post_error=error)
            receipt = R.run(self.env(tempdir), send=send, now=NOW)
            self.assertEqual(receipt["reason"], "ROTATION_STATE_UNCERTAIN")
            self.assertEqual(receipt["production_mutations"], "UNKNOWN_AFTER_ROTATE_REQUEST")
            self.assertEqual([request.method for request in calls], ["GET", "POST"])
            self.assertEqual(sum(request.method == "POST" for request in calls), 1)
            self.assertNotIn("private-provider-error", json.dumps(receipt))
            self.assertFalse((Path(tempdir) / "rotation.json").exists())

    def test_invalid_post_response_is_uncertain(self):
        with tempfile.TemporaryDirectory() as tempdir:
            calls, send = self.sender(rotate_result={"success": False, "errors": [{"message": "private"}]})
            receipt = R.run(self.env(tempdir), send=send, now=NOW)
            self.assertEqual(receipt["reason"], "ROTATION_STATE_UNCERTAIN")
            self.assertEqual(receipt["production_mutations"], "UNKNOWN_AFTER_ROTATE_REQUEST")
            self.assertEqual([request.method for request in calls], ["GET", "POST"])
            self.assertNotIn("private", json.dumps(receipt))

    def test_unexpected_rotated_secret_format_is_uncertain_after_one_post(self):
        with tempfile.TemporaryDirectory() as tempdir:
            calls, send = self.sender(rotate_result={
                "success": True,
                "result": {
                    "id": TOKEN_ID,
                    "client_id": CLIENT_ID,
                    "client_secret": "unexpected-private-format",
                },
            })
            receipt = R.run(self.env(tempdir), send=send, now=NOW)
            self.assertEqual(receipt["reason"], "ROTATION_STATE_UNCERTAIN")
            self.assertEqual(receipt["production_mutations"], "UNKNOWN_AFTER_ROTATE_REQUEST")
            self.assertEqual([request.method for request in calls], ["GET", "POST"])
            self.assertEqual(sum(request.method == "POST" for request in calls), 1)
            self.assertNotIn("unexpected-private-format", json.dumps(receipt))
            self.assertFalse((Path(tempdir) / "rotation.json").exists())


if __name__ == "__main__":
    unittest.main()
