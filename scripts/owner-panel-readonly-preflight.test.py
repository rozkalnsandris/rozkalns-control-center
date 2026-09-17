import contextlib
import io
import json
import importlib.util
from unittest.mock import patch
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("preflight", ROOT / "scripts/owner-panel-readonly-preflight.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
VERSION = "11111111-1111-1111-1111-111111111111"
DEPLOYMENT = "22222222-2222-2222-2222-222222222222"


def schema_rows():
    db = sqlite3.connect(":memory:")
    for name in ("0007_continuation_campaigns.sql", "0014_continuation_action_audit.sql"):
        db.executescript((ROOT / "migrations" / name).read_text())
    rows = [{"name": name, "sql": sql} for name, sql in db.execute(
        "SELECT name,sql FROM sqlite_schema WHERE type='table'")]
    db.close()
    return rows


class PreflightTest(unittest.TestCase):
    def test_single_baseline_and_traffic(self):
        payload = {"deployments": [{"id": DEPLOYMENT, "versions": [{"version_id": VERSION, "percentage": 100}]}]}
        self.assertEqual(p.baseline(payload), (DEPLOYMENT, VERSION))
        payload["deployments"][0]["versions"][0]["percentage"] = 0
        with self.assertRaisesRegex(ValueError, "BASELINE_NOT_100"):
            p.baseline(payload)

    def test_binding_inventory_never_returns_protected_values(self):
        bindings = [{"name": "GITHUB_APP_PRIVATE_KEY_PEM", "type": "secret_text", "text": "synthetic-private-value"},
                    {"name": "CONTROL_CONTINUATION_RUNTIME_ENABLED", "type": "plain_text", "text": "false"}]
        result = p.binding_inventory(bindings)
        self.assertEqual(result["GITHUB_APP_PRIVATE_KEY_PEM"], "PRESENT_PROTECTED")
        self.assertEqual(result["CONTROL_CONTINUATION_RUNTIME_ENABLED"], "DIFFERENT")
        self.assertNotIn("synthetic-private-value", str(result))
        self.assertEqual(len(result["non_target_bindings_sha256"]), 64)
        with self.assertRaisesRegex(ValueError, "DUPLICATE_BINDING"):
            p.binding_inventory(bindings + [bindings[0]])

    def test_sql_is_fixed_and_redirects_forbidden(self):
        with self.assertRaisesRegex(ValueError, "SQL_NOT_ALLOWED"):
            p.request(p.CF + "/d1/database/" + p.DB + "/query", "synthetic", sql="DELETE FROM d1_migrations")
        with self.assertRaisesRegex(ValueError, "URL_NOT_ALLOWED"):
            p.request("https://example.invalid", "synthetic")
        with self.assertRaisesRegex(ValueError, "URL_NOT_ALLOWED"):
            p.request(p.GRAPHQL, "synthetic")
        self.assertIsNone(p.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid"))
        self.assertTrue(all(sql.startswith("SELECT ") and ";" not in sql for sql in p.SQL_ALLOWLIST))
        self.assertIn("/workers/domains?hostname=", p.worker_domains_url())
        with patch.object(p.urllib.request, "build_opener") as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value = b"{}"
            self.assertEqual(p.request(p.worker_domains_url(), "synthetic"), {})
            self.assertEqual(build.return_value.open.call_args.args[0].get_method(), "GET")
            payload = p.graphql_access_login_payload(
                "0123456789abcdef-XYZ", p.datetime.datetime.now(p.datetime.timezone.utc))
            self.assertEqual(p.request(p.GRAPHQL, "synthetic", graphql=payload), {})
            self.assertEqual(build.return_value.open.call_args.args[0].get_method(), "POST")

    def test_audience_metadata_never_proves_human_owner_access(self):
        name = "CONTROL_CONTINUATION_ACCESS_AUDIENCE"
        self.assertEqual(p.binding_inventory([])[name], "ABSENT")
        for value in ("a" * 64, "new-human-app-audience"):
            result = p.binding_inventory([{"name": name, "type": "plain_text", "text": value}])
            self.assertEqual(result[name], "PRESENT_UNVERIFIED")
            self.assertNotIn(value, str(result))
        for value in ("", "bad audience", None):
            self.assertEqual(p.binding_inventory([{"name": name, "type": "plain_text", "text": value}])[name], "INVALID")

    def test_zero_mutation_metadata_is_mandatory(self):
        payload = {"success": True, "result": [{"success": True, "results": [],
                    "meta": {"changed_db": False, "rows_written": 0}}]}
        self.assertEqual(p.select_rows(payload), [])
        for meta in ({}, {"changed_db": True, "rows_written": 0}, {"changed_db": False, "rows_written": 1}):
            payload["result"][0]["meta"] = meta
            with self.assertRaisesRegex(ValueError, "D1_ZERO_WRITES"):
                p.select_rows(payload)

    def test_actual_sqlite_schema_matches_source_and_detects_drift(self):
        rows = schema_rows()
        names = ["0007_continuation_campaigns.sql", "0014_continuation_action_audit.sql"]
        result = p.schema_inventory(rows, names, ROOT)
        self.assertEqual(result["continuation_action_audit"], "MATCH")
        self.assertEqual(result["continuation_campaigns"], "MATCH")
        self.assertEqual(result["continuation_tasks"], "MATCH")
        self.assertTrue(result["migration_0014_recorded"])
        rows[0]["sql"] += " DRIFT"
        self.assertEqual(p.schema_inventory(rows, names, ROOT)[rows[0]["name"]], "DIFFERENT")
        self.assertEqual(p.schema_inventory([], [], ROOT)["continuation_action_audit"], "ABSENT")

    def test_full_inventory_is_readonly_and_never_grants_activation(self):
        env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main",
               "GITHUB_SHA": "a" * 40, "GITHUB_TOKEN": "synthetic",
               "CLOUDFLARE_WORKERS_READ_TOKEN": "synthetic", "CLOUDFLARE_D1_READ_TOKEN": "synthetic"}
        calls = []
        def read(url, token, sql=None, **kwargs):
            calls.append((url, sql))
            if url == p.GH + "/branches/main":
                return {"commit": {"sha": env["GITHUB_SHA"]}}
            if url.startswith(p.GH + "/actions/workflows/"):
                return {"workflow_runs": [{"id": 1, "run_number": 1, "head_sha": env["GITHUB_SHA"],
                        "event": "push", "head_branch": "main", "path": ".github/workflows/ci.yml",
                        "status": "completed", "conclusion": "success"}]}
            if url.endswith("/deployments"):
                return {"success": True, "result": {"deployments": [{"id": DEPLOYMENT,
                        "versions": [{"version_id": VERSION, "percentage": 100}]}]}}
            if "/versions/" in url:
                return {"success": True, "result": {"id": VERSION, "resources": {"bindings": []}}}
            if url.endswith("/query"):
                data = ([{"name": "0007_continuation_campaigns.sql"}, {"name": "0014_continuation_action_audit.sql"}]
                        if sql == p.MIGRATIONS else schema_rows() if sql == p.SCHEMA else
                        [{"campaign_count": 0, "linked_count": None}])
                return {"success": True, "result": [{"success": True, "results": data,
                        "meta": {"changed_db": False, "rows_written": 0, "changes": 0}}]}
            return {"success": True, "result": {"uuid": p.DB, "name": "rozkalns-control-production", "jurisdiction": "eu"}}
        result = p.run(env, ROOT, read)
        self.assertEqual(result["production_mutations"], 0)
        self.assertFalse(result["activation_ready"])
        self.assertEqual(result["d1"]["continuation_action_audit"], "MATCH")
        self.assertEqual(len([sql for _, sql in calls if sql]), 3)
        self.assertTrue(all(sql is None or sql in p.SQL_ALLOWLIST for _, sql in calls))
        self.assertNotIn("synthetic", str(result))
        env["CONTROL_ACCESS_CLIENT_ID"] = "synthetic"
        env["CONTROL_ACCESS_CLIENT_SECRET"] = "synthetic"
        def complete_read(url, token, **kwargs):
            if url == p.ORIGIN + "/api/health":
                return {"status": "ok", "service": p.WORKER, "workerVersion": VERSION}
            if url == p.ORIGIN + "/":
                return b'<div id="root"></div><script src="/assets/app.js"></script>'
            return read(url, token, **kwargs)
        stages = ["GITHUB_MAIN", "GITHUB_CI", "WORKER_DEPLOYMENTS",
                  "WORKER_VERSION_BINDINGS", "D1_IDENTITY", "D1_MIGRATIONS",
                  "D1_SCHEMA", "D1_CAMPAIGNS", "WORKER_HEALTH", "UI_SHELL",
                  "FINAL_MAIN", "FINAL_DEPLOYMENT"]
        for fail_at, stage in enumerate(stages, 1):
            with self.subTest(stage=stage):
                attempted = []
                def failed_read(url, token, **kwargs):
                    attempted.append(url)
                    if len(attempted) == fail_at:
                        raise p.urllib.error.HTTPError(url, 403, "synthetic-protected", {}, None)
                    return complete_read(url, token, **kwargs)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    status = p.main(env, ROOT, failed_read)
                self.assertEqual(status, 1)
                receipt = json.loads(output.getvalue())
                self.assertEqual(receipt["stage"], stage)
                self.assertEqual(receipt["code"], "HTTP_ERROR")
                self.assertEqual(receipt["http_status"], 403)
                expected_attempts = fail_at + (1 if stage == "WORKER_HEALTH" else 0)
                self.assertEqual(len(attempted), expected_attempts)
                self.assertNotIn("synthetic", output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(env, ROOT, complete_read), 0)
        self.assertFalse(json.loads(output.getvalue())["activation_ready"])
        env["GITHUB_REF_NAME"] = "feature"
        before = len(calls)
        with self.assertRaisesRegex(ValueError, "MAIN_DISPATCH"):
            p.run(env, ROOT, read)
        self.assertEqual(len(calls), before)


class DiagnosticsTest(unittest.TestCase):
    def test_health_403_is_classified_without_exposing_response_or_policy_selectors(self):
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main",
            "GITHUB_SHA": "a" * 40, "GITHUB_TOKEN": "synthetic-github",
            "CLOUDFLARE_WORKERS_READ_TOKEN": "synthetic-workers",
            "CLOUDFLARE_D1_READ_TOKEN": "synthetic-d1",
            "CONTROL_ACCESS_CLIENT_ID": "synthetic-client-id",
            "CONTROL_ACCESS_CLIENT_SECRET": "synthetic-client-secret",
            "CLOUDFLARE_ACCESS_READ_TOKEN": "synthetic-access-read",
        }
        health_body = json.dumps({
            "error": "ACCESS_AUTHENTICATION_FAILED",
            "diagnostic": "ACCESS_JWT_AUDIENCE_INVALID",
            "unexpected": "synthetic-protected-response",
        }).encode()
        app_id = "33333333-3333-4333-8333-333333333333"
        service_token_id = "44444444-4444-4444-8444-444444444444"
        ray_id = "0123456789abcdef-XYZ"
        calls = []

        def read(url, token, sql=None, **kwargs):
            calls.append(url)
            if url == p.ORIGIN + "/api/health":
                raise p.urllib.error.HTTPError(
                    url, 403, "synthetic-protected", {"CF-Ray": ray_id}, io.BytesIO(health_body))
            if url == p.access_apps_url(1):
                return {"success": True, "result": [{
                    "id": app_id, "type": "self_hosted",
                    "destinations": [{"type": "public", "uri": p.ORIGIN + "/api/health"}],
                }]}
            if url == p.access_app_policies_url(app_id, 1):
                return {"success": True, "result": [{
                    "decision": "non_identity",
                    "include": [{"service_token": {"token_id": service_token_id}}],
                }]}
            if url == p.access_service_tokens_url(1):
                return {"success": True, "result": [{
                    "id": service_token_id,
                    "client_id": "synthetic-client-id",
                    "enabled": True,
                }]}
            if url == p.worker_domains_url():
                return {"success": True, "result": [{
                    "hostname": "control.rozkalns.net", "service": p.WORKER,
                }]}
            if url == p.GRAPHQL:
                payload = kwargs["graphql"]
                self.assertEqual(payload["query"], p.ACCESS_LOGIN_EVENT_QUERY)
                self.assertEqual(payload["variables"]["accountTag"], p.ACCOUNT)
                self.assertEqual(payload["variables"]["rayId"], ray_id)
                self.assertEqual(set(payload["variables"]),
                                 {"accountTag", "rayId", "datetimeStart", "datetimeEnd"})
                return {"data": {"viewer": {"accounts": [{
                    "accessLoginRequestsAdaptiveGroups": [{"dimensions": {
                        "isSuccessfulLogin": 1, "identityProvider": "nonidentity",
                        "serviceTokenId": service_token_id,
                    }}],
                }]}}, "errors": None}
            if url == p.GH + "/branches/main":
                return {"commit": {"sha": env["GITHUB_SHA"]}}
            if url.startswith(p.GH + "/actions/workflows/"):
                return {"workflow_runs": [{"id": 1, "run_number": 1, "head_sha": env["GITHUB_SHA"],
                        "event": "push", "head_branch": "main", "path": ".github/workflows/ci.yml",
                        "status": "completed", "conclusion": "success"}]}
            if url.endswith("/deployments"):
                return {"success": True, "result": {"deployments": [{"id": DEPLOYMENT,
                        "versions": [{"version_id": VERSION, "percentage": 100}]}]}}
            if "/versions/" in url:
                return {"success": True, "result": {"id": VERSION, "resources": {"bindings": []}}}
            if url.endswith("/query"):
                data = ([{"name": "0007_continuation_campaigns.sql"}, {"name": "0014_continuation_action_audit.sql"}]
                        if sql == p.MIGRATIONS else schema_rows() if sql == p.SCHEMA else
                        [{"campaign_count": 0, "linked_count": None}])
                return {"success": True, "result": [{"success": True, "results": data,
                        "meta": {"changed_db": False, "rows_written": 0, "changes": 0}}]}
            return {"success": True, "result": {"uuid": p.DB, "name": "rozkalns-control-production", "jurisdiction": "eu"}}

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(env, ROOT, read), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["stage"], "WORKER_HEALTH")
        self.assertEqual(receipt["health_403"]["response_class"], "WORKER_ACCESS_JWT_AUDIENCE_INVALID")
        self.assertEqual(receipt["health_403"]["credential_presence"], {
            "access_client_id": True, "access_client_secret": True, "access_read_token": True,
        })
        self.assertEqual(receipt["health_403"]["access_applicability"], {
            "matching_application_count": 1,
            "matching_policy_count": 1,
            "non_identity_policy_count": 1,
            "service_token_selector_policy_count": 1,
            "service_token_match": "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED",
            "service_token_policy_eligibility": "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED",
        })
        self.assertEqual(receipt["health_403"]["worker_domain_mapping"],
                         "PROVEN_CUSTOM_DOMAIN_SERVICE_MATCH")
        self.assertEqual(receipt["health_403"]["access_event"],
                         "PROVEN_ACCESS_SERVICE_TOKEN_AUTHORIZED")
        self.assertIn(p.access_apps_url(1), calls)
        self.assertIn(p.access_app_policies_url(app_id, 1), calls)
        self.assertIn(p.access_service_tokens_url(1), calls)
        self.assertIn(p.worker_domains_url(), calls)
        self.assertEqual(calls.count(p.GRAPHQL), 1)
        self.assertNotIn("synthetic", output.getvalue())
        self.assertNotIn(ray_id, output.getvalue())

    def test_worker_domain_mapping_is_bounded_and_does_not_publish_provider_data(self):
        private_value = "synthetic-private-domain-value"
        self.assertEqual(
            p.health_worker_domain_mapping("synthetic-workers", lambda *_args: {
                "success": True, "result": [{"hostname": "control.rozkalns.net", "service": p.WORKER}],
            }),
            "PROVEN_CUSTOM_DOMAIN_SERVICE_MATCH",
        )
        self.assertEqual(
            p.health_worker_domain_mapping("synthetic-workers", lambda *_args: {
                "success": True, "result": [{"hostname": "control.rozkalns.net", "service": private_value}],
            }),
            "NOT_PROVEN_CUSTOM_DOMAIN_SERVICE_MISMATCH",
        )
        body = unittest.mock.Mock()
        body.read.return_value = private_value.encode()
        def denied(*_args):
            raise p.urllib.error.HTTPError(p.worker_domains_url(), 403, private_value, {}, body)
        result = p.health_worker_domain_mapping("synthetic-workers", denied)
        self.assertEqual(result, "NOT_PROVEN_CUSTOM_DOMAIN_READ_FAILED")
        self.assertNotIn(private_value, result)
        body.read.assert_not_called()

    def test_access_event_permission_denial_is_bounded_and_never_reads_error_data(self):
        private_value = "synthetic-private-analytics-value"
        ray_id = "0123456789abcdef-XYZ"
        error = p.urllib.error.HTTPError(
            p.ORIGIN + "/api/health", 403, private_value, {"CF-Ray": ray_id}, None)
        body = unittest.mock.Mock()
        calls = []

        def denied(url, _token, **kwargs):
            calls.append((url, kwargs["graphql"]))
            raise p.urllib.error.HTTPError(url, 403, private_value, {}, body)

        result = p.health_access_event(
            "synthetic-access-read", error, p.datetime.datetime.now(p.datetime.timezone.utc), denied)
        self.assertEqual(result, "PROVEN_ACCOUNT_ANALYTICS_READ_MISSING")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], p.GRAPHQL)
        self.assertEqual(calls[0][1]["variables"]["rayId"], ray_id)
        self.assertNotIn(private_value, result)
        body.read.assert_not_called()

        absent = p.urllib.error.HTTPError(p.ORIGIN + "/api/health", 403, private_value, {}, None)
        self.assertEqual(
            p.health_access_event("synthetic-access-read", absent,
                                  p.datetime.datetime.now(p.datetime.timezone.utc),
                                  lambda *_args, **_kwargs: self.fail("Unexpected GraphQL request")),
            "NOT_PROVEN_CF_RAY_HEADER_ABSENT_OR_INVALID",
        )

    def test_access_event_payload_never_returns_provider_dimensions(self):
        private_token_id = "synthetic-private-service-token-id"
        result = p.access_event_result({"data": {"viewer": {"accounts": [{
            "accessLoginRequestsAdaptiveGroups": [{"dimensions": {
                "isSuccessfulLogin": 0, "identityProvider": "nonidentity",
                "serviceTokenId": private_token_id,
            }}],
        }]}}, "errors": None})
        self.assertEqual(result, "PROVEN_ACCESS_NONIDENTITY_DENIED")
        self.assertNotIn(private_token_id, result)
        self.assertEqual(p.access_event_result({"data": {}, "errors": []}),
                         "NOT_PROVEN_GRAPHQL_RESPONSE_ERROR")

    def test_access_event_errors_are_reduced_to_documented_categories_without_output(self):
        private_value = "synthetic-private-graphql-error"
        cases = (
            ({"message": "query time range is too large " + private_value},
             "PROVEN_GRAPHQL_DATASET_LIMIT"),
            ({"message": "unknown field " + private_value},
             "PROVEN_GRAPHQL_QUERY_MALFORMED"),
            ({"message": "unable to execute query, please try again later"},
             "PROVEN_GRAPHQL_SERVICE_UNAVAILABLE"),
            ({"message": private_value, "extensions": {"code": "budget"}},
             "PROVEN_GRAPHQL_RATE_LIMIT"),
            ({"message": "not authorized for that account"},
             "PROVEN_GRAPHQL_ACCOUNT_NOT_AUTHORIZED"),
            ({"message": private_value, "path": [
                "viewer", "accounts", 0, "accessLoginRequestsAdaptiveGroups",
            ]}, "PROVEN_GRAPHQL_ACCESS_LOGIN_EVENT_PATH"),
            ({"message": private_value, "path": [
                "viewer", "accounts", private_value, "accessLoginRequestsAdaptiveGroups",
            ]}, "PROVEN_GRAPHQL_ERROR_PATH_PRESENT_UNRECOGNIZED"),
            ({"message": private_value}, "NOT_PROVEN_GRAPHQL_ERROR_PATH_ABSENT_OR_INVALID"),
        )
        for error, expected in cases:
            result = p.access_event_result({"data": None, "errors": [error]})
            self.assertEqual(result, expected)
            self.assertNotIn(private_value, result)

    def test_selected_service_token_policy_eligibility_is_bounded(self):
        token_id = "44444444-4444-4444-8444-444444444444"
        policy = {
            "decision": "non_identity",
            "include": [{"service_token": {"token_id": token_id}}],
        }
        match = "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED"
        ids = frozenset((token_id,))
        self.assertEqual(
            p.selected_service_token_policy_eligibility([policy], match, ids),
            "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED",
        )
        self.assertEqual(
            p.selected_service_token_policy_eligibility(
                [dict(policy, require=[{"ip": {"ip": "192.0.2.0/24"}}])], match, ids),
            "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_CONSTRAINED",
        )
        self.assertEqual(
            p.selected_service_token_policy_eligibility([dict(policy, decision="allow")], match, ids),
            "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_NOT_SERVICE_AUTH",
        )
        self.assertEqual(
            p.selected_service_token_policy_eligibility([policy], "NOT_PROVEN_SERVICE_TOKEN_DISABLED", ids),
            "NOT_PROVEN_SERVICE_TOKEN_MATCH",
        )

    def test_json_403_classes_do_not_publish_unrecognized_fields(self):
        opaque = io.BytesIO(json.dumps({"error": "synthetic-private-error"}).encode())
        error = p.urllib.error.HTTPError(p.ORIGIN + "/api/health", 403, "synthetic", {}, opaque)
        self.assertEqual(p.health_403_response_class(error), "JSON_NOT_WORKER_ACCESS_AUTH_SCHEMA")
        unknown = io.BytesIO(json.dumps({
            "error": "ACCESS_AUTHENTICATION_FAILED",
            "diagnostic": "SYNTHETIC_PRIVATE_DIAGNOSTIC",
        }).encode())
        error = p.urllib.error.HTTPError(p.ORIGIN + "/api/health", 403, "synthetic", {}, unknown)
        self.assertEqual(
            p.health_403_response_class(error),
            "WORKER_ACCESS_AUTHENTICATION_FAILED_UNRECOGNIZED_DIAGNOSTIC",
        )

    def test_service_token_read_denial_is_bounded_and_does_not_leak_provider_data(self):
        app_id = "33333333-3333-4333-8333-333333333333"
        token_id = "44444444-4444-4444-8444-444444444444"
        private_body = unittest.mock.Mock()

        def read(url, _token, **_kwargs):
            if url == p.access_apps_url(1):
                return {"success": True, "result": [{
                    "id": app_id, "type": "self_hosted",
                    "destinations": [{"type": "public", "uri": p.ORIGIN + "/api/health"}],
                }]}
            if url == p.access_app_policies_url(app_id, 1):
                return {"success": True, "result": [{
                    "include": [{"service_token": {"token_id": token_id}}],
                }]}
            if url == p.access_service_tokens_url(1):
                raise p.urllib.error.HTTPError(url, 403, "synthetic-private", {}, private_body)
            self.fail("Unexpected URL")

        result = p.health_access_applicability("synthetic-access-read", "synthetic-client-id", read)
        self.assertEqual(result["service_token_match"], "NOT_PROVEN_SERVICE_TOKENS_READ_DENIED")
        self.assertNotIn("synthetic", json.dumps(result))
        private_body.read.assert_not_called()

    def test_health_403_body_read_is_bounded_and_unrecognized_data_stays_unpublished(self):
        body = io.BytesIO(b"{" + b"x" * (p.HEALTH_DIAGNOSTIC_MAX_BYTES + 1))
        error = p.urllib.error.HTTPError(p.ORIGIN + "/api/health", 403, "synthetic", {}, body)
        result = p.health_403_diagnostic(
            error, {}, lambda *_args, **_kwargs: self.fail("Unexpected Access read"),
            p.datetime.datetime.now(p.datetime.timezone.utc))
        self.assertEqual(result["response_class"], "BODY_TOO_LARGE")
        self.assertEqual(result["access_applicability"]["service_token_match"], "NOT_PROVEN_ACCESS_READ_CREDENTIAL_ABSENT")
        self.assertEqual(result["access_event"], "NOT_PROVEN_ANALYTICS_READ_CREDENTIAL_ABSENT")
        self.assertNotIn("x", json.dumps(result))

    def test_error_categories_and_protected_data_are_sanitized(self):
        marker = "synthetic-protected-value"
        cases = [
            (p.PreflightError("MAIN_DRIFT"), "MAIN_DRIFT", None),
            (p.PreflightError(marker), "CONTRACT_ERROR", None),
            (p.PreflightError(["MAIN_DRIFT"]), "CONTRACT_ERROR", None),
            (p.urllib.error.HTTPError(marker, 403, marker, {"secret": marker}, io.BytesIO(marker.encode())), "HTTP_ERROR", 403),
            (p.urllib.error.HTTPError(marker, marker, marker, {}, None), "HTTP_ERROR", None),
            (p.urllib.error.URLError(marker), "NETWORK_ERROR", None),
            (TimeoutError(marker), "NETWORK_TIMEOUT", None),
            (json.JSONDecodeError(marker, marker, 0), "RESPONSE_DECODE_ERROR", None),
            (KeyError(marker), "RESPONSE_SHAPE_INVALID", None),
            (OSError(marker), "IO_ERROR", None),
            (ValueError(marker), "UNEXPECTED_ERROR", None),
        ]
        for error, code, status in cases:
            with self.subTest(code=code):
                receipt = p.failure_receipt(error, {"stage": "D1_SCHEMA"})
                self.assertEqual(receipt["stage"], "D1_SCHEMA")
                self.assertEqual(receipt["code"], code)
                self.assertEqual(receipt["http_status"], status)
                self.assertFalse(receipt["activation_ready"])
                self.assertEqual(receipt["production_mutations"], 0)
                self.assertNotIn(marker, json.dumps(receipt))
        for stage in (marker, []):
            self.assertEqual(p.failure_receipt(ValueError(marker), {"stage": stage})["stage"], "UNKNOWN")

    def test_cli_contract_failure_is_nonzero_without_network(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = p.main({}, ROOT, lambda *args: self.fail("Unexpected request"))
        self.assertEqual(status, 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["stage"], "ENVIRONMENT")
        self.assertEqual(receipt["code"], "MAIN_DISPATCH_REQUIRED")

    def test_http_error_never_reads_body_or_retries(self):
        body = unittest.mock.Mock()
        error = p.urllib.error.HTTPError(p.GH + "/branches/main", 429, "synthetic-protected", {}, body)
        with patch.object(p.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = error
            with self.assertRaises(p.urllib.error.HTTPError):
                p.request(p.GH + "/branches/main", "synthetic-token")
            self.assertEqual(build.return_value.open.call_count, 1)
            self.assertEqual(build.return_value.open.call_args.args[0].get_method(), "GET")
            body.read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
