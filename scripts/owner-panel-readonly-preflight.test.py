import importlib.util
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
        env["GITHUB_REF_NAME"] = "feature"
        before = len(calls)
        with self.assertRaisesRegex(ValueError, "MAIN_DISPATCH"):
            p.run(env, ROOT, read)
        self.assertEqual(len(calls), before)


if __name__ == "__main__":
    unittest.main()
