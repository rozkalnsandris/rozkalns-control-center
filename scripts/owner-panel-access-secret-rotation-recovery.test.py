#!/usr/bin/env python3
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error

PATH = pathlib.Path(__file__).with_name("owner-panel-access-secret-rotation-recovery.py")
SPEC = importlib.util.spec_from_file_location("rotation_recovery", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "3537a672-e4d8-4d89-aab9-26cb622918a1"
CLIENT_ID = "88bf3b6d86161464f6509f7219099e57.access"


def list_payload():
    return {
        "success": True,
        "result": [{"id": TOKEN_ID, "client_id": CLIENT_ID, "enabled": True}],
    }


def detail_payload(**overrides):
    result = {
        "id": TOKEN_ID,
        "client_id": CLIENT_ID,
        "enabled": True,
        "client_secret_version": 2,
        "updated_at": "2026-09-19T08:36:31Z",
        "previous_client_secret_expires_at": "2026-09-19T09:36:31Z",
    }
    result.update(overrides)
    return {"success": True, "result": result}


class RecoveryTests(unittest.TestCase):
    def test_strong_incident_signature(self):
        calls = []

        def read(req):
            calls.append((req.method, req.full_url))
            return list_payload() if "?per_page=" in req.full_url else detail_payload()

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ROTATION_RECOVERY_METADATA_COMPLETE")
        self.assertEqual(receipt["service_token_match"], "PROVEN_SELECTOR_MATCH_ENABLED")
        self.assertEqual(receipt["client_secret_version_shape"], "VERSION_GE_TWO")
        self.assertEqual(receipt["updated_at_relation"], "UPDATED_AT_INCIDENT_WINDOW_MATCH")
        self.assertEqual(receipt["previous_secret_grace_relation"], "PREVIOUS_SECRET_GRACE_MATCH")
        self.assertEqual(receipt["rotation_metadata_signature"], "VERSION_UPDATED_GRACE_MATCH")
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertEqual([method for method, _ in calls], ["GET", "GET"])

    def test_no_incident_signal(self):
        def read(req):
            if "?per_page=" in req.full_url:
                return list_payload()
            return detail_payload(
                client_secret_version=1,
                updated_at="2026-09-18T08:36:31Z",
                previous_client_secret_expires_at=None,
            )

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        self.assertEqual(receipt["client_secret_version_shape"], "VERSION_ONE")
        self.assertEqual(receipt["updated_at_relation"], "UPDATED_AT_INCIDENT_WINDOW_BEFORE")
        self.assertEqual(receipt["previous_secret_grace_relation"], "PREVIOUS_SECRET_GRACE_ABSENT")
        self.assertEqual(receipt["rotation_metadata_signature"], "NO_INCIDENT_METADATA_SIGNAL")

    def test_metadata_fields_unavailable(self):
        def read(req):
            if "?per_page=" in req.full_url:
                return list_payload()
            return detail_payload(
                client_secret_version=None,
                updated_at=None,
                previous_client_secret_expires_at=None,
            )

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        self.assertEqual(receipt["rotation_metadata_signature"], "METADATA_FIELDS_UNAVAILABLE")

    def test_partial_signal_is_bounded(self):
        def read(req):
            if "?per_page=" in req.full_url:
                return list_payload()
            return detail_payload(
                updated_at="2026-09-01T00:00:00Z",
                previous_client_secret_expires_at=None,
            )

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        self.assertEqual(receipt["rotation_metadata_signature"], "PARTIAL_METADATA_SIGNAL")

    def test_no_credential_makes_no_request(self):
        calls = 0

        def read(_req):
            nonlocal calls
            calls += 1
            raise AssertionError("must not request")

        receipt = MOD.probe("", CLIENT_ID, read)
        self.assertEqual(receipt["detail"], "ROTATION_RECOVERY_CREDENTIAL_UNAVAILABLE")
        self.assertEqual(calls, 0)

    def test_read_denied_is_fixed_enum(self):
        provider_detail = "provider-detail-should-not-leak"

        def read(_req):
            raise urllib.error.HTTPError(
                "https://example.invalid", 403, "denied", {}, io.BytesIO(provider_detail.encode())
            )

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        encoded = json.dumps(receipt, sort_keys=True)
        self.assertEqual(receipt["detail"], "ROTATION_RECOVERY_READ_DENIED")
        self.assertNotIn(provider_detail, encoded)
        self.assertNotIn("example.invalid", encoded)
        self.assertNotIn("denied", encoded)

    def test_detail_never_leaks_secret_or_identifiers(self):
        def read(req):
            if "?per_page=" in req.full_url:
                return list_payload()
            payload = detail_payload()
            payload["result"]["client_secret"] = "cfast_" + "A" * 48
            payload["result"]["name"] = "private-name"
            return payload

        receipt = MOD.probe("read-token", CLIENT_ID, read)
        encoded = json.dumps(receipt, sort_keys=True)
        self.assertNotIn(CLIENT_ID, encoded)
        self.assertNotIn(TOKEN_ID, encoded)
        self.assertNotIn("cfast_", encoded)
        self.assertNotIn("private-name", encoded)


if __name__ == "__main__":
    unittest.main()
