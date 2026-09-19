#!/usr/bin/env python3
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error

PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-proof.py")
SPEC = importlib.util.spec_from_file_location("write_token_proof", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "3537a672-e4d8-4d89-aab9-26cb622918a1"
CLIENT_ID = "88bf3b6d86161464f6509f7219099e57.access"


def verify_payload(status="active"):
    return {"success": True, "result": {"id": "a" * 32, "status": status}}


def list_payload():
    return {
        "success": True,
        "result": [{"id": TOKEN_ID, "client_id": CLIENT_ID, "enabled": True}],
    }


def detail_payload():
    return {
        "success": True,
        "result": {"id": TOKEN_ID, "client_id": CLIENT_ID, "enabled": True},
    }


class WriteTokenProofTests(unittest.TestCase):
    def test_active_token_and_service_token_get_access(self):
        calls = []

        def read(req):
            calls.append((req.method, req.full_url))
            if req.full_url == MOD.VERIFY:
                return verify_payload()
            if "?per_page=" in req.full_url:
                return list_payload()
            return detail_payload()

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_GET_PROOF_COMPLETE")
        self.assertEqual(receipt["write_token_status"], "PROVEN_ACTIVE")
        self.assertEqual(receipt["service_token_get_access"], "PROVEN_LIST_AND_GET")
        self.assertEqual(receipt["selected_service_token_match"], "PROVEN_SELECTOR_MATCH_ENABLED")
        self.assertEqual(
            receipt["permission_interpretation"],
            "PROVEN_SERVICE_TOKEN_READ_OR_WRITE_ACCEPTED",
        )
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertEqual([method for method, _ in calls], ["GET", "GET", "GET"])

    def test_no_credential_makes_no_request(self):
        calls = 0

        def read(_req):
            nonlocal calls
            calls += 1
            raise AssertionError("must not request")

        receipt = MOD.probe("", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_CREDENTIAL_UNAVAILABLE")
        self.assertEqual(calls, 0)

    def test_401_is_bounded_authentication_failure(self):
        def read(_req):
            raise urllib.error.HTTPError(
                "https://example.invalid", 401, "unauthorized", {}, io.BytesIO(b"raw provider detail")
            )

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_AUTHENTICATION_FAILED")
        self.assertNotIn("provider", json.dumps(receipt))

    def test_403_is_bounded_service_token_access_failure(self):
        def read(req):
            if req.full_url == MOD.VERIFY:
                return verify_payload()
            raise urllib.error.HTTPError(
                "https://example.invalid", 403, "denied", {}, io.BytesIO(b"raw provider detail")
            )

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_SERVICE_TOKEN_ACCESS_NOT_GRANTED")
        self.assertEqual(receipt["production_mutations"], 0)

    def test_inactive_token_is_unproven_not_leaked(self):
        def read(req):
            if req.full_url == MOD.VERIFY:
                return verify_payload("disabled")
            raise AssertionError("must stop after verify")

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")
        self.assertEqual(receipt["write_token_status"], "NOT_PROVEN")

    def test_selected_target_mismatch_is_bounded(self):
        def read(req):
            if req.full_url == MOD.VERIFY:
                return verify_payload()
            if "?per_page=" in req.full_url:
                return list_payload()
            payload = detail_payload()
            payload["result"]["client_id"] = "other.access"
            return payload

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")

    def test_receipt_never_contains_credentials_or_identifiers(self):
        def read(req):
            if req.full_url == MOD.VERIFY:
                payload = verify_payload()
                payload["result"]["value"] = "write-token-secret"
                return payload
            if "?per_page=" in req.full_url:
                return list_payload()
            payload = detail_payload()
            payload["result"]["client_secret"] = "cfast_" + "A" * 48
            return payload

        receipt = MOD.probe("write-token", CLIENT_ID, read)
        encoded = json.dumps(receipt, sort_keys=True)
        self.assertNotIn("write-token-secret", encoded)
        self.assertNotIn(CLIENT_ID, encoded)
        self.assertNotIn(TOKEN_ID, encoded)
        self.assertNotIn("cfast_", encoded)


if __name__ == "__main__":
    unittest.main()
