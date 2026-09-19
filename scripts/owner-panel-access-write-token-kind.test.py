#!/usr/bin/env python3
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error

PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-kind.py")
SPEC = importlib.util.spec_from_file_location("write_token_kind", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "owner-panel-readonly-preflight.yml"


def active_payload():
    return {"success": True, "result": {"id": "a" * 32, "status": "active"}}


class AccessWriteTokenKindTests(unittest.TestCase):
    def test_user_owned_prefix_uses_user_verify_once(self):
        calls = []
        token = "cfut_" + "u" * 40

        def read(url, value):
            calls.append((url, value))
            return active_payload()

        receipt = MOD.classify(token, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_KIND_PROOF_COMPLETE")
        self.assertEqual(receipt["format_kind_hint"], "USER_OWNED")
        self.assertEqual(receipt["token_kind"], "USER_OWNED")
        self.assertEqual(receipt["token_status"], "PROVEN_ACTIVE")
        self.assertEqual(receipt["verification_endpoint"], "USER_VERIFY")
        self.assertEqual(receipt["network_requests"], 1)
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertFalse(receipt["secret_value_exposed"])
        self.assertEqual(calls, [(MOD.USER_VERIFY, token)])
        self.assertNotIn(token, json.dumps(receipt))

    def test_account_owned_prefix_uses_account_verify_once(self):
        calls = []
        token = "cfat_" + "a" * 40

        def read(url, value):
            calls.append((url, value))
            return active_payload()

        receipt = MOD.classify(token, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_KIND_PROOF_COMPLETE")
        self.assertEqual(receipt["format_kind_hint"], "ACCOUNT_OWNED")
        self.assertEqual(receipt["token_kind"], "ACCOUNT_OWNED")
        self.assertEqual(receipt["verification_endpoint"], "ACCOUNT_VERIFY")
        self.assertEqual(receipt["network_requests"], 1)
        self.assertEqual(calls, [(MOD.ACCOUNT_VERIFY, token)])
        self.assertNotIn(token, json.dumps(receipt))

    def test_legacy_or_unknown_format_fails_closed_without_network(self):
        calls = 0

        def read(_url, _value):
            nonlocal calls
            calls += 1
            raise AssertionError("legacy format must not request")

        receipt = MOD.classify("legacy-token-value", read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_LEGACY_FORMAT_UNPROVEN")
        self.assertEqual(receipt["format_kind_hint"], "LEGACY_UNPROVEN")
        self.assertEqual(receipt["token_kind"], "NOT_PROVEN")
        self.assertEqual(receipt["network_requests"], 0)
        self.assertEqual(calls, 0)

    def test_missing_credential_fails_closed_without_network(self):
        calls = 0

        def read(_url, _value):
            nonlocal calls
            calls += 1
            raise AssertionError("missing credential must not request")

        receipt = MOD.classify("", read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_CREDENTIAL_UNAVAILABLE")
        self.assertEqual(receipt["network_requests"], 0)
        self.assertEqual(calls, 0)

    def test_inactive_token_does_not_prove_kind(self):
        token = "cfut_" + "u" * 40
        receipt = MOD.classify(
            token,
            lambda _url, _value: {"success": True, "result": {"id": "b" * 32, "status": "disabled"}},
        )
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_KIND_VERIFY_FAILED")
        self.assertEqual(receipt["format_kind_hint"], "USER_OWNED")
        self.assertEqual(receipt["token_kind"], "NOT_PROVEN")
        self.assertEqual(receipt["verify_class"], "TOKEN_NOT_ACTIVE")

    def test_provider_error_is_bounded_and_does_not_leak(self):
        token = "cfat_" + "a" * 40

        def read(url, _value):
            raise urllib.error.HTTPError(
                url,
                403,
                "denied",
                {},
                io.BytesIO(b"raw-provider-secret-detail"),
            )

        receipt = MOD.classify(token, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_KIND_VERIFY_FAILED")
        self.assertEqual(receipt["token_kind"], "NOT_PROVEN")
        self.assertEqual(receipt["verify_class"], "UNCLASSIFIED_FAILURE")
        self.assertNotIn("raw-provider-secret-detail", json.dumps(receipt))
        self.assertNotIn(token, json.dumps(receipt))

    def test_readonly_workflow_wires_only_the_write_token_secret(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("- access-write-token-kind", workflow)
        self.assertIn("inputs.diagnostic == 'access-write-token-kind'", workflow)
        self.assertIn("run: python3 scripts/owner-panel-access-write-token-kind.py", workflow)
        marker = "- name: Bounded Access write-token ownership proof only"
        self.assertIn(marker, workflow)
        step = workflow.split(marker, 1)[1]
        self.assertIn("CLOUDFLARE_ACCESS_WRITE_TOKEN: ${{ secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN }}", step)


if __name__ == "__main__":
    unittest.main()
