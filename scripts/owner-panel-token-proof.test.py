import contextlib
import copy
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
PRIVATE_ID = "a" * 32
TOKEN = "cfut_" + "synthetic-private-fixture"


def envelope(value):
    return {"success": True, "errors": [], "result": value}


def details():
    return {"id": PRIVATE_ID, "status": "active", "policies": [{
        "effect": "allow", "permission_groups": [{"name": "Account Analytics Read"}],
        "resources": {"com.cloudflare.api.account." + p.ACCOUNT: "*"}}]}


class ProofTests(unittest.TestCase):
    def run_proof(self, data=None, token=TOKEN, verify=None):
        calls = []
        def read(path, bearer):
            calls.append((path, bearer))
            self.assertLessEqual(len(calls), 2)
            if len(calls) == 1:
                return envelope(verify if verify is not None else {"id": PRIVATE_ID, "status": "active"})
            if isinstance(data, Exception):
                raise data
            return envelope(details() if data is None else data)
        return p.prove(token, read), calls

    def test_user_identity_binding_and_two_gets(self):
        receipt, calls = self.run_proof()
        self.assertEqual(receipt["result"], "ANALYTICS_GRANTED_FOR_TARGET")
        self.assertEqual(calls, [("/user/tokens/verify", TOKEN), ("/user/tokens/" + PRIVATE_ID, TOKEN)])

    def test_account_namespace(self):
        receipt, calls = self.run_proof(token="cfat_synthetic-fixture")
        self.assertTrue(receipt["identity_proven"])
        self.assertEqual(calls[0][0], "/accounts/" + p.ACCOUNT + "/tokens/verify")
        self.assertEqual(calls[1][0], "/accounts/" + p.ACCOUNT + "/tokens/" + PRIVATE_ID)

    def test_unknown_type_never_guesses_or_falls_back(self):
        for token in ("legacy-fixture", "cfk_fixture", "", None):
            receipt, calls = self.run_proof(token=token)
            self.assertFalse(receipt["identity_proven"])
            self.assertEqual(calls, [])

    def test_invalid_verification_stops_before_details(self):
        for value in ({}, {"id": "../private", "status": "active"},
                      {"id": PRIVATE_ID, "status": "expired"},
                      {"id": PRIVATE_ID, "status": "disabled"}):
            receipt, calls = self.run_proof(verify=value)
            self.assertFalse(receipt["identity_proven"])
            self.assertEqual(len(calls), 1)

    def test_verify_error_never_retries(self):
        calls = []
        def read(path, bearer):
            calls.append(path)
            raise urllib.error.HTTPError(path, 403, "private", {}, None)
        self.assertEqual(p.prove(TOKEN, read)["result"], "SELF_VERIFY_FAILED")
        self.assertEqual(len(calls), 1)

    def test_details_denial_is_not_missing_analytics(self):
        error = urllib.error.HTTPError("private", 403, "private", {}, None)
        for token, expected in ((TOKEN, "USER_TOKEN_METADATA_READ_DENIED"),
                                ("cfat_fixture", "ACCOUNT_TOKEN_METADATA_READ_DENIED")):
            receipt, calls = self.run_proof(error, token)
            self.assertEqual(receipt["result"], expected)
            self.assertEqual(len(calls), 2)

    def test_other_details_errors_remain_unproven(self):
        for error in (ValueError("private"), urllib.error.HTTPError("private", 401, "private", {}, None)):
            self.assertEqual(self.run_proof(error)[0]["result"], "TOKEN_METADATA_READ_UNPROVEN")

    def test_details_identity_and_status_must_match(self):
        for key, value in (("id", "b" * 32), ("status", "disabled")):
            data = details()
            data[key] = value
            self.assertEqual(self.run_proof(data)[0]["result"], "DETAILS_IDENTITY_OR_STATUS_MISMATCH")

    def test_wildcard_scope(self):
        data = details()
        data["policies"][0]["resources"] = {"com.cloudflare.api.account.*": "*"}
        self.assertEqual(self.run_proof(data)[0]["result"], "ANALYTICS_GRANTED_FOR_TARGET")

    def test_permission_and_scope_must_be_in_same_policy(self):
        data = details()
        other = copy.deepcopy(data["policies"][0])
        data["policies"][0]["resources"] = {"com.cloudflare.api.account." + "b" * 32: "*"}
        other["permission_groups"] = [{"name": "Access: Apps Read"}]
        data["policies"].append(other)
        self.assertEqual(self.run_proof(data)[0]["result"], "ANALYTICS_NOT_GRANTED_FOR_TARGET")

    def test_unsupported_or_incomplete_policy_is_unknown(self):
        for key, value in (("effect", "deny"), ("resources", {"*": "*"}),
                           ("resources", {"com.cloudflare.api.account.*": {}}),
                           ("permission_groups", [{"id": "private"}])):
            data = details()
            data["policies"][0][key] = value
            self.assertEqual(self.run_proof(data)[0]["result"], "POLICY_UNPROVEN")

    def test_malformed_envelope(self):
        for value in (None, [], {}, {"success": True, "errors": ["private"], "result": {}}):
            self.assertEqual(p.prove(TOKEN, lambda *_: value)["result"], "SELF_VERIFY_FAILED")

    def test_stdout_only_fixed_receipt(self):
        output = io.StringIO()
        def read(*_):
            raise RuntimeError(TOKEN + PRIVATE_ID + p.ACCOUNT)
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main({"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN}, read), 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "identity_proven": False, "production_mutations": False, "result": "SELF_VERIFY_FAILED"})

    def test_get_allowlist_blocks_before_network(self):
        with patch.object(p.urllib.request, "build_opener") as opener:
            for path in ("/graphql", "/user/tokens", "/user/tokens/../x", "/accounts/other/tokens/verify"):
                with self.assertRaises(ValueError):
                    p.get(path, TOKEN)
            opener.assert_not_called()

    def test_no_redirect(self):
        self.assertIsNone(p.NoRedirect().redirect_request(None, None, 302, None, None, "https://example.com"))

    def test_transport_uses_single_get_and_bounds_body(self):
        with patch.object(p.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{}'
            self.assertEqual(p.get("/user/tokens/verify", TOKEN), {})
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
            response.read.assert_called_once_with(262145)
            opener.return_value.open.assert_called_once()
            response.read.return_value = b'x' * 262145
            with self.assertRaises(ValueError):
                p.get("/user/tokens/verify", TOKEN)

    def test_success_output_does_not_leak_metadata(self):
        calls = []
        def read(path, bearer):
            calls.append(path)
            return envelope({"id": PRIVATE_ID, "status": "active"} if len(calls) == 1 else details())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(p.main({"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN}, read), 0)
        for private in (PRIVATE_ID, TOKEN, p.ACCOUNT, "Account Analytics Read", "policies", "resources"):
            self.assertNotIn(private, output.getvalue())

    def test_workflow_isolation_and_ci_wiring(self):
        workflow = (ROOT / ".github/workflows/owner-panel-readonly-preflight.yml").read_text()
        proof_step = workflow.split("- name: Token Analytics permission proof only")[1].split("- name:")[0]
        self.assertIn("if: inputs.diagnostic == 'token-analytics-proof'", proof_step)
        self.assertIn("secrets.CLOUDFLARE_ACCESS_READ_TOKEN", proof_step)
        self.assertNotIn("CONTROL_ACCESS_CLIENT", proof_step)
        self.assertIn("if: inputs.diagnostic == 'inventory'", workflow)
        self.assertIn("default: none", workflow)
        self.assertIn("owner-panel-token-proof.test.py", (ROOT / ".github/workflows/ci.yml").read_text())


if __name__ == "__main__":
    unittest.main()
