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
        self.assertIsNone(p.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid"))
        self.assertTrue(all(sql.startswith("SELECT ") and ";" not in sql for sql in p.SQL_ALLOWLIST))

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
                self.assertEqual(len(attempted), fail_at)
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
