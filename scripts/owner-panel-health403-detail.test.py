import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "health403_detail", ROOT / "scripts/owner-panel-health403-detail.py")
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
P = D.P

APP_ID = "33333333-3333-4333-8333-333333333333"
TOKEN_ID = "44444444-4444-4444-8444-444444444444"
NOW = datetime.datetime(2026, 9, 18, 16, 40, tzinfo=datetime.timezone.utc)


class Health403DetailTest(unittest.TestCase):
    def token_read(self, expires_at, enabled=True, client_id="synthetic-client-id",
                   decision="non_identity", require=None, exclude=None):
        def read(url, _token, **_kwargs):
            if url == P.access_apps_url(1):
                return {"success": True, "result": [{
                    "id": APP_ID,
                    "type": "self_hosted",
                    "destinations": [{"type": "public", "uri": P.ORIGIN + "/api/health"}],
                }]}
            if url == P.access_app_policies_url(APP_ID, 1):
                policy = {
                    "decision": decision,
                    "include": [{"service_token": {"token_id": TOKEN_ID}}],
                }
                if require is not None:
                    policy["require"] = require
                if exclude is not None:
                    policy["exclude"] = exclude
                return {"success": True, "result": [policy]}
            if url == P.access_service_tokens_url(1):
                return {"success": True, "result": [{
                    "id": TOKEN_ID,
                    "client_id": client_id,
                    "enabled": enabled,
                    "expires_at": expires_at,
                }]}
            self.fail("Unexpected URL: " + url)
        return read

    def test_selected_service_token_expiry_is_bounded(self):
        future = "2026-09-19T16:40:00Z"
        past = "2026-09-17T16:40:00Z"
        self.assertEqual(
            D.selected_service_token_lifetime(
                "synthetic-read", "synthetic-client-id", self.token_read(future), NOW),
            "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_UNEXPIRED",
        )
        self.assertEqual(
            D.selected_service_token_lifetime(
                "synthetic-read", "synthetic-client-id", self.token_read(past), NOW),
            "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_EXPIRED",
        )
        self.assertEqual(
            D.selected_service_token_lifetime(
                "synthetic-read", "synthetic-client-id", self.token_read(future, enabled=False), NOW),
            "PROVEN_SELECTED_SERVICE_TOKEN_DISABLED",
        )
        for value in (None, "", "not-a-time", "2026-09-19T16:40:00"):
            with self.subTest(expires_at=value):
                result = D.selected_service_token_lifetime(
                    "synthetic-read", "synthetic-client-id", self.token_read(value), NOW)
                self.assertEqual(result, "NOT_PROVEN_SELECTED_SERVICE_TOKEN_EXPIRY")
                if value not in (None, ""):
                    self.assertNotIn(str(value), result)

    def test_service_token_match_is_exact_and_private(self):
        result = D.selected_service_token_lifetime(
            "synthetic-read", "synthetic-client-id",
            self.token_read("2026-09-19T16:40:00Z", client_id="other-private-client"), NOW)
        self.assertEqual(result, "NOT_PROVEN_SELECTED_SERVICE_TOKEN_MATCH")
        self.assertNotIn("other-private-client", result)

    def test_policy_eligibility_is_bounded(self):
        future = "2026-09-19T16:40:00Z"
        metadata = D.selected_service_token_metadata(
            "synthetic-read", "synthetic-client-id", self.token_read(future), NOW)
        self.assertEqual(metadata, {
            "service_token_lifetime": "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_UNEXPIRED",
            "service_token_match": "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED",
            "service_token_policy_eligibility": "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED",
        })
        metadata = D.selected_service_token_metadata(
            "synthetic-read", "synthetic-client-id",
            self.token_read(future, decision="allow"), NOW)
        self.assertEqual(
            metadata["service_token_policy_eligibility"],
            "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_NOT_SERVICE_AUTH",
        )
        metadata = D.selected_service_token_metadata(
            "synthetic-read", "synthetic-client-id",
            self.token_read(future, require=[{"ip": "synthetic"}]), NOW)
        self.assertEqual(
            metadata["service_token_policy_eligibility"],
            "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_CONSTRAINED",
        )

    def test_graphql_documented_top_level_errors_override_null_path(self):
        cases = (
            ({"message": "Unauthorized", "path": None}, "PROVEN_GRAPHQL_UNAUTHORIZED"),
            ({"message": "Internal server error", "path": None},
             "PROVEN_GRAPHQL_INTERNAL_SERVER_ERROR"),
            ({"message": "not authorized for that account", "path": None},
             "PROVEN_GRAPHQL_ACCOUNT_NOT_AUTHORIZED"),
            ({"message": "synthetic-private", "path": None}, "PROVEN_GRAPHQL_ERROR_PATH_NULL"),
        )
        for error, expected in cases:
            with self.subTest(expected=expected):
                result = D.graphql_top_level_result({"data": None, "errors": [error]})
                self.assertEqual(result, expected)
                self.assertNotIn("synthetic-private", result)

    def test_full_detail_is_one_shot_and_never_returns_secrets_or_ray(self):
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF_NAME": "main",
            "GITHUB_SHA": "a" * 40,
            "CLOUDFLARE_ACCESS_READ_TOKEN": "synthetic-access-read-secret",
            "CONTROL_ACCESS_CLIENT_ID": "synthetic-client-id",
            "CONTROL_ACCESS_CLIENT_SECRET": "synthetic-client-secret",
        }
        ray_header = "0123456789abcdef-FRA"
        calls = []
        worker_body = json.dumps({
            "error": "ACCESS_AUTHENTICATION_FAILED",
            "diagnostic": "ACCESS_JWT_SIGNATURE_INVALID",
            "private": "must-not-leak",
        }).encode()

        def read(url, token, **kwargs):
            calls.append(url)
            if url == P.ORIGIN + "/api/health":
                raise P.urllib.error.HTTPError(
                    url, 403, "synthetic-private-health", {"CF-Ray": ray_header}, io.BytesIO(worker_body))
            if url == P.access_apps_url(1):
                return {"success": True, "result": [{
                    "id": APP_ID,
                    "type": "self_hosted",
                    "destinations": [{"type": "public", "uri": P.ORIGIN + "/api/health"}],
                }]}
            if url == P.access_app_policies_url(APP_ID, 1):
                return {"success": True, "result": [{
                    "decision": "non_identity",
                    "include": [{"service_token": {"token_id": TOKEN_ID}}],
                }]}
            if url == P.access_service_tokens_url(1):
                return {"success": True, "result": [{
                    "id": TOKEN_ID,
                    "client_id": "synthetic-client-id",
                    "enabled": True,
                    "expires_at": "2026-09-19T16:40:00Z",
                }]}
            if url == P.GRAPHQL:
                self.assertEqual(kwargs["graphql"]["variables"]["rayId"], "0123456789abcdef")
                return {"data": None, "errors": [{"message": "Unauthorized", "path": None}]}
            self.fail("Unexpected URL: " + url)

        receipt = D.health403_detail(env, read, NOW)
        self.assertEqual(receipt, {
            "detail": "BOUNDED_HEALTH403_DETAIL_COMPLETE",
            "health_403_response_class": "WORKER_ACCESS_JWT_SIGNATURE_INVALID",
            "service_token_lifetime": "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_UNEXPIRED",
            "service_token_match": "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED",
            "service_token_policy_eligibility": "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED",
            "client_secret_validity": "NOT_PROVEN_BY_METADATA",
            "graphql_access_event": "PROVEN_GRAPHQL_UNAUTHORIZED",
            "production_mutations": 0,
            "activation_ready": False,
        })
        self.assertEqual(calls.count(P.ORIGIN + "/api/health"), 1)
        self.assertEqual(calls.count(P.access_apps_url(1)), 1)
        self.assertEqual(calls.count(P.access_app_policies_url(APP_ID, 1)), 1)
        self.assertEqual(calls.count(P.access_service_tokens_url(1)), 1)
        self.assertEqual(calls.count(P.GRAPHQL), 1)
        rendered = json.dumps(receipt)
        for private in ("synthetic-access-read-secret", "synthetic-client-secret", TOKEN_ID,
                        ray_header, "0123456789abcdef", "must-not-leak"):
            self.assertNotIn(private, rendered)

    def test_contract_failures_do_not_touch_network(self):
        calls = []
        result = D.health403_detail({}, lambda *args, **kwargs: calls.append((args, kwargs)), NOW)
        self.assertEqual(result["reason"], "MAIN_DISPATCH_REQUIRED")
        self.assertEqual(calls, [])

        env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main", "GITHUB_SHA": "a" * 40}
        result = D.health403_detail(env, lambda *args, **kwargs: calls.append((args, kwargs)), NOW)
        self.assertEqual(result["reason"], "REQUIRED_READ_CREDENTIAL_ABSENT")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
