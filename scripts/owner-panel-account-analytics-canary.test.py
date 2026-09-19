import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "account_analytics_canary", ROOT / "scripts/owner-panel-account-analytics-canary.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)

NOW = datetime.datetime(2026, 9, 19, 7, 30, tzinfo=datetime.timezone.utc)


class AccountAnalyticsCanaryTest(unittest.TestCase):
    def test_success_empty_dataset_proves_account_analytics(self):
        calls = []

        def read(token, now):
            calls.append((token, now))
            return {
                "data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": []}]}},
                "errors": None,
            }

        receipt = C.prove("synthetic-private-token", read, NOW)
        self.assertEqual(receipt, {
            "account_analytics_authorization_proven": True,
            "production_mutations": False,
            "result": "ACCOUNT_ANALYTICS_GRANTED_FOR_TARGET",
        })
        self.assertEqual(len(calls), 1)
        self.assertNotIn("synthetic-private-token", json.dumps(receipt))

    def test_authz_extension_proves_permission_missing(self):
        receipt = C.prove(
            "synthetic-private-token",
            lambda _token, _now: {
                "data": None,
                "errors": [{
                    "message": "synthetic-private-provider-message",
                    "path": None,
                    "extensions": {"code": "authz"},
                }],
            },
            NOW,
        )
        self.assertEqual(receipt["result"], "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET")
        self.assertFalse(receipt["account_analytics_authorization_proven"])
        self.assertNotIn("synthetic-private-provider-message", json.dumps(receipt))

    def test_http_statuses_are_bounded(self):
        for code, expected in (
            (401, "TOKEN_AUTHENTICATION_FAILED"),
            (403, "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET"),
            (429, "GRAPHQL_RATE_LIMITED"),
            (503, "GRAPHQL_SERVICE_UNAVAILABLE"),
        ):
            with self.subTest(code=code):
                def read(_token, _now, code=code):
                    raise urllib.error.HTTPError(
                        C.GRAPHQL, code, "synthetic-private", {}, io.BytesIO(b"private"))

                receipt = C.prove("synthetic-private-token", read, NOW)
                self.assertEqual(receipt["result"], expected)
                self.assertNotIn("synthetic-private", json.dumps(receipt))

    def test_query_rejection_is_bounded(self):
        receipt = C.prove(
            "synthetic-private-token",
            lambda _token, _now: {
                "data": None,
                "errors": [{
                    "message": "private query detail",
                    "path": None,
                    "extensions": {"code": "validation"},
                }],
            },
            NOW,
        )
        self.assertEqual(receipt["result"], "GRAPHQL_QUERY_REJECTED")
        self.assertNotIn("private query detail", json.dumps(receipt))

    def test_unclassified_provider_error_never_leaks(self):
        receipt = C.prove(
            "synthetic-private-token",
            lambda _token, _now: {
                "data": None,
                "errors": [{
                    "message": "opaque-private-message-123",
                    "extensions": {"code": "opaque-private-code"},
                }],
            },
            NOW,
        )
        rendered = json.dumps(receipt)
        self.assertEqual(receipt["result"], "GRAPHQL_RESPONSE_UNPROVEN")
        self.assertNotIn("opaque-private-message-123", rendered)
        self.assertNotIn("opaque-private-code", rendered)
        self.assertNotIn("synthetic-private-token", rendered)

    def test_missing_credential_makes_no_request(self):
        calls = []
        receipt = C.prove(None, lambda *args: calls.append(args), NOW)
        self.assertEqual(receipt["result"], "CREDENTIAL_UNAVAILABLE")
        self.assertEqual(calls, [])

    def test_payload_is_fixed_target_and_five_minute_window(self):
        payload = C.payload(NOW)
        self.assertEqual(set(payload), {"query", "variables"})
        self.assertEqual(payload["query"], C.QUERY)
        self.assertEqual(payload["variables"], {
            "accountTag": C.ACCOUNT,
            "datetimeStart": "2026-09-19T07:25:00Z",
            "datetimeEnd": "2026-09-19T07:30:00Z",
            "scriptName": C.SCRIPT_NAME,
        })
        self.assertIn("workersInvocationsAdaptive", C.QUERY)
        self.assertIn("limit: 1", C.QUERY)


if __name__ == "__main__":
    unittest.main()
