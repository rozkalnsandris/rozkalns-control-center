import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("proof", ROOT / "scripts/owner-panel-token-proof.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
TOKEN = "synthetic-private-fixture"
NOW = datetime.datetime(2026, 9, 18, 17, 0, tzinfo=datetime.timezone.utc)


def success(events=None):
    return {
        "data": {"viewer": {"accounts": [{
            "accessLoginRequestsAdaptiveGroups": [] if events is None else events
        }]}},
        "errors": None,
    }


def graphql_errors(*messages):
    return {"data": None, "errors": [{"message": message} for message in messages]}


class ProofTests(unittest.TestCase):
    def run_proof(self, value=None, error=None, token=TOKEN):
        calls = []
        def read(bearer, now):
            calls.append((bearer, now))
            self.assertEqual(len(calls), 1)
            if error is not None:
                raise error
            return success() if value is None else value
        return p.prove(token, read, NOW), calls

    def test_success_proves_target_authorization_with_empty_dataset(self):
        receipt, calls = self.run_proof()
        self.assertTrue(receipt["graphql_authorization_proven"])
        self.assertEqual(receipt["result"], "ANALYTICS_GRANTED_FOR_TARGET")
        self.assertEqual(calls, [(TOKEN, NOW)])
        self.assertFalse(receipt["production_mutations"])

    def test_token_format_is_irrelevant_to_direct_graphql_probe(self):
        for token in ("cfut_fixture", "cfat_fixture", "legacy_fixture", "opaque-fixture"):
            receipt, calls = self.run_proof(token=token)
            self.assertEqual(receipt["result"], "ANALYTICS_GRANTED_FOR_TARGET")
            self.assertEqual(len(calls), 1)

    def test_missing_token_stops_before_network(self):
        for token in ("", None):
            receipt, calls = self.run_proof(token=token)
            self.assertEqual(receipt["result"], "CREDENTIAL_UNAVAILABLE")
            self.assertFalse(receipt["graphql_authorization_proven"])
            self.assertEqual(calls, [])

    def test_http_authz_and_provider_failures_are_bounded(self):
        cases = (
            (401, "TOKEN_AUTHENTICATION_FAILED"),
            (403, "ANALYTICS_NOT_GRANTED_FOR_TARGET"),
            (429, "GRAPHQL_RATE_LIMITED"),
            (500, "GRAPHQL_SERVICE_UNAVAILABLE"),
            (503, "GRAPHQL_SERVICE_UNAVAILABLE"),
            (418, "GRAPHQL_HTTP_UNPROVEN"),
        )
        for code, expected in cases:
            error = urllib.error.HTTPError(p.GRAPHQL, code, "private", {}, None)
            receipt, calls = self.run_proof(error=error)
            self.assertEqual(receipt["result"], expected)
            self.assertEqual(len(calls), 1)

    def test_graphql_200_error_classification(self):
        cases = (
            (graphql_errors("Unauthorized"), "TOKEN_AUTHENTICATION_FAILED"),
            (graphql_errors("not authorized for that account"), "ANALYTICS_NOT_GRANTED_FOR_TARGET"),
            (graphql_errors("does not have access to the path viewer.accounts"), "ANALYTICS_NOT_GRANTED_FOR_TARGET"),
            (graphql_errors("zones [private] are not authorized"), "ANALYTICS_NOT_GRANTED_FOR_TARGET"),
            (graphql_errors("rate limiter budget depleted, try again after 5 minutes"), "GRAPHQL_RATE_LIMITED"),
            (graphql_errors("query consumed excessive resources, please try running smaller queries which consume fewer resources"),
             "GRAPHQL_RATE_LIMITED"),
            (graphql_errors("Internal server error"), "GRAPHQL_SERVICE_UNAVAILABLE"),
            (graphql_errors("unknown field private"), "GRAPHQL_QUERY_REJECTED"),
            ({"data": None, "errors": [{"message": "private", "path": None}]},
             "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSIONS_KEY_ABSENT"),
        )
        for value, expected in cases:
            self.assertEqual(self.run_proof(value=value)[0]["result"], expected)

    def test_unclassified_graphql_error_paths_are_bounded(self):
        cases = (
            ({"data": None, "errors": [{
                "message": "private",
                "path": ["viewer", "accounts", 0, "accessLoginRequestsAdaptiveGroups"],
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_ACCESS_DATASET"),
            ({"data": None, "errors": [{
                "message": "private",
                "path": ["viewer", "accounts", "0", "accessLoginRequestsAdaptiveGroups"],
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_ACCESS_DATASET"),
            ({"data": None, "errors": [{
                "message": "private",
                "path": ["viewer", "accounts", 0, "private"],
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_PRESENT_UNRECOGNIZED"),
            (graphql_errors("private"), "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_KEY_ABSENT"),
            ({"data": None, "errors": [{"message": "private", "path": None}]},
             "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSIONS_KEY_ABSENT"),
            ({"data": None, "errors": [{"message": "private", "path": "private"}]},
             "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_PRESENT_INVALID_NON_NULL"),
            ({"data": None, "errors": [
                {"message": "private-a", "path": None},
                {"message": "private-b"},
            ]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_MIXED_OR_INVALID"),
        )
        for value, expected in cases:
            self.assertEqual(self.run_proof(value=value)[0]["result"], expected)

    def test_path_null_extension_codes_are_bounded(self):
        cases = (
            ({"data": None, "errors": [{
                "message": "private",
                "path": None,
                "extensions": {"code": "budget", "timestamp": "private"},
            }]}, "GRAPHQL_RATE_LIMITED"),
            ({"data": None, "errors": [{
                "message": "private",
                "path": None,
                "extensions": {"code": "private"},
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED"),
            ({"data": None, "errors": [{"message": "private", "path": None}]},
             "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSIONS_KEY_ABSENT"),
            ({"data": None, "errors": [{
                "message": "private", "path": None, "extensions": {}
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_KEY_ABSENT"),
            ({"data": None, "errors": [{
                "message": "private", "path": None, "extensions": {"code": None}
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_NULL"),
            ({"data": None, "errors": [{
                "message": "private", "path": None, "extensions": {"code": 7}
            }]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_INVALID_NON_STRING"),
            ({"data": None, "errors": [
                {"message": "private-a", "path": None, "extensions": {"code": "budget"}},
                {"message": "private-b", "path": None},
            ]}, "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_MIXED_OR_INVALID"),
        )
        for value, expected in cases:
            self.assertEqual(self.run_proof(value=value)[0]["result"], expected)

    def test_success_response_shape_is_bounded(self):
        cases = (
            ({"errors": None, "data": {"viewer": {"accounts": []}}},
             "GRAPHQL_SUCCESS_TARGET_ACCOUNT_UNPROVEN"),
            ({"errors": None, "data": {"viewer": {"accounts": [{}, {}]}}},
             "GRAPHQL_SUCCESS_TARGET_ACCOUNT_UNPROVEN"),
            ({"errors": None, "data": {"viewer": {"accounts": ["private"]}}},
             "GRAPHQL_SUCCESS_DATA_SHAPE_UNPROVEN"),
            ({"errors": None, "data": {"viewer": {"accounts": [{}]}}},
             "GRAPHQL_SUCCESS_DATASET_SHAPE_UNPROVEN"),
            ({"errors": None, "data": {"viewer": {"accounts": [{
                "accessLoginRequestsAdaptiveGroups": [{}, {}]}]}}},
             "GRAPHQL_SUCCESS_DATASET_SHAPE_UNPROVEN"),
            ({"data": {}, "errors": None}, "GRAPHQL_SUCCESS_DATA_SHAPE_UNPROVEN"),
            ({"data": {}, "errors": []}, "GRAPHQL_ERRORS_SHAPE_UNPROVEN"),
            ({}, "GRAPHQL_ERRORS_FIELD_MISSING"),
            ([], "GRAPHQL_RESPONSE_NOT_OBJECT"),
        )
        for value, expected in cases:
            self.assertEqual(self.run_proof(value=value)[0]["result"], expected)

    def test_graphql_error_shape_is_bounded(self):
        values = (
            {"data": None, "errors": []},
            {"data": None, "errors": ["private"]},
            {"data": None, "errors": [{"message": ""}]},
            {"data": None, "errors": [{"message": "x" * 2001}]},
            {"data": None, "errors": [{"message": "private"}] * 11},
        )
        for value in values:
            self.assertEqual(self.run_proof(value=value)[0]["result"], "GRAPHQL_ERRORS_SHAPE_UNPROVEN")

    def test_network_or_decode_error_is_unproven_without_retry(self):
        for error in (ValueError("private"), urllib.error.URLError("private"),
                      TimeoutError("private"), json.JSONDecodeError("x", "x", 0)):
            receipt, calls = self.run_proof(error=error)
            self.assertEqual(receipt["result"], "GRAPHQL_REQUEST_UNPROVEN")
            self.assertEqual(len(calls), 1)

    def test_payload_is_fixed_target_and_five_minute_window(self):
        value = p.payload(NOW)
        self.assertEqual(value["query"], p.QUERY)
        self.assertNotIn("\n", value["query"])
        self.assertEqual(value["query"], " ".join(value["query"].split()))
        variables = value["variables"]
        self.assertEqual(set(variables), {"accountTag", "rayId", "datetimeStart", "datetimeEnd"})
        self.assertEqual(variables["accountTag"], p.ACCOUNT)
        self.assertEqual(variables["rayId"], p.SYNTHETIC_RAY)
        self.assertEqual(variables["datetimeStart"], "2026-09-18T16:55:00Z")
        self.assertEqual(variables["datetimeEnd"], "2026-09-18T17:00:00Z")

    def test_transport_is_one_post_to_exact_graphql_endpoint(self):
        with patch.object(p.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = json.dumps(success()).encode()
            self.assertEqual(p.post(TOKEN, NOW), success())
            opener.return_value.open.assert_called_once()
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, p.GRAPHQL)
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
            self.assertEqual(request.get_header("Content-type"), "application/json")
            posted = json.loads(request.data)
            self.assertEqual(posted, p.payload(NOW))
            response.read.assert_called_once_with(p.MAX_BODY + 1)

    def test_transport_rejects_oversize_body(self):
        with patch.object(p.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b"x" * (p.MAX_BODY + 1)
            with self.assertRaises(ValueError):
                p.post(TOKEN, NOW)

    def test_no_redirect(self):
        self.assertIsNone(p.NoRedirect().redirect_request(
            None, None, 302, None, None, "https://example.com"))

    def test_stdout_only_fixed_receipt_and_no_secret_or_provider_details(self):
        output = io.StringIO()
        def read(*_):
            return graphql_errors("does not have access to the path " + TOKEN + p.ACCOUNT)
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main({"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN}, read), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt, {
            "graphql_authorization_proven": False,
            "production_mutations": False,
            "result": "ANALYTICS_NOT_GRANTED_FOR_TARGET",
        })
        for private in (TOKEN, p.ACCOUNT, "does not have access", p.QUERY, p.SYNTHETIC_RAY):
            self.assertNotIn(private, output.getvalue())

    def test_unclassified_error_receipt_does_not_leak_message_or_path(self):
        output = io.StringIO()
        private_message = "private provider detail " + TOKEN + p.ACCOUNT
        private_path_value = "private-path-" + TOKEN + p.ACCOUNT
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(
                {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                lambda *_: {"data": None, "errors": [{
                    "message": private_message,
                    "path": ["viewer", "accounts", 0, private_path_value],
                }]}), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["result"],
                         "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_PRESENT_UNRECOGNIZED")
        for private in (private_message, private_path_value, TOKEN, p.ACCOUNT):
            self.assertNotIn(private, output.getvalue())

    def test_unclassified_extension_code_receipt_does_not_leak_details(self):
        output = io.StringIO()
        private_message = "private provider detail " + TOKEN + p.ACCOUNT
        private_code = "private-code-" + TOKEN + p.ACCOUNT
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(
                {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                lambda *_: {"data": None, "errors": [{
                    "message": private_message,
                    "path": None,
                    "extensions": {"code": private_code, "timestamp": "private"},
                }]}), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED",
        )
        for private in (private_message, private_code, TOKEN, p.ACCOUNT):
            self.assertNotIn(private, output.getvalue())

    def test_success_stdout_is_sanitized(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main(
                {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                lambda *_: success()), 0)
        self.assertEqual(json.loads(output.getvalue())["result"], "ANALYTICS_GRANTED_FOR_TARGET")
        for private in (TOKEN, p.ACCOUNT, p.QUERY, p.SYNTHETIC_RAY):
            self.assertNotIn(private, output.getvalue())

    def test_workflow_isolation_and_ci_wiring(self):
        workflow = (ROOT / ".github/workflows/owner-panel-readonly-preflight.yml").read_text()
        proof_step = workflow.split("- name: Token Analytics permission proof only")[1].split("- name:")[0]
        self.assertIn("if: inputs.diagnostic == 'token-analytics-proof'", proof_step)
        self.assertIn("secrets.CLOUDFLARE_ACCESS_READ_TOKEN", proof_step)
        self.assertNotIn("CONTROL_ACCESS_CLIENT", proof_step)
        self.assertIn("if: inputs.diagnostic == 'inventory'", workflow)
        self.assertIn("default: none", workflow)
        self.assertIn("owner-panel-token-proof.test.py",
                      (ROOT / ".github/workflows/ci.yml").read_text())

    def test_source_has_no_token_metadata_introspection_routes(self):
        source = (ROOT / "scripts/owner-panel-token-proof.py").read_text()
        self.assertNotIn("/user/tokens", source)
        self.assertNotIn("/accounts/\" + ACCOUNT + \"/tokens", source)
        self.assertNotIn("permission_groups", source)
        self.assertNotIn("policies", source)


if __name__ == "__main__":
    unittest.main()
