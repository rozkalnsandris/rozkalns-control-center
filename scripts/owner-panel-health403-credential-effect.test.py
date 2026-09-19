import importlib.util
import io
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "health403_credential_effect", ROOT / "scripts/owner-panel-health403-credential-effect.py")
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
P = D.P

ENV = {
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REF_NAME": "main",
    "GITHUB_SHA": "a" * 40,
    "CONTROL_ACCESS_CLIENT_ID": "synthetic-client-id",
    "CONTROL_ACCESS_CLIENT_SECRET": "synthetic-client-secret",
}


class CredentialEffectTest(unittest.TestCase):
    def http_error(self, url, status, body):
        return P.urllib.error.HTTPError(
            url, status, "synthetic-private-status", {"CF-Ray": "private-ray"}, io.BytesIO(body))

    def test_same_403_class_is_bounded_and_two_gets_only(self):
        calls = []
        edge_body = json.dumps({"private": "must-not-leak"}).encode()

        def read(url, token, **kwargs):
            calls.append((url, token, kwargs))
            self.assertEqual(url, P.ORIGIN + "/api/health")
            self.assertIsNone(token)
            self.assertTrue(kwargs.get("html"))
            raise self.http_error(url, 403, edge_body)

        receipt = D.credential_effect(ENV, read)
        self.assertEqual(receipt, {
            "detail": "BOUNDED_HEALTH403_CREDENTIAL_EFFECT_COMPLETE",
            "authenticated_health_response_class": "JSON_NOT_WORKER_ACCESS_AUTH_SCHEMA",
            "access_credentials_edge_effect": "NO_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS",
            "production_mutations": 0,
        })
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][2].get("access"),
                         ("synthetic-client-id", "synthetic-client-secret"))
        self.assertIsNone(calls[1][2].get("access"))
        rendered = json.dumps(receipt)
        for private in ("synthetic-client-secret", "synthetic-client-id", "must-not-leak", "private-ray"):
            self.assertNotIn(private, rendered)

    def test_different_403_class_is_proven_without_raw_body(self):
        calls = 0
        worker_body = json.dumps({
            "error": "ACCESS_AUTHENTICATION_FAILED",
            "diagnostic": "ACCESS_JWT_SIGNATURE_INVALID",
            "private": "worker-private",
        }).encode()
        edge_body = json.dumps({"private": "edge-private"}).encode()

        def read(url, _token, **kwargs):
            nonlocal calls
            calls += 1
            body = edge_body if kwargs.get("access") else worker_body
            raise self.http_error(url, 403, body)

        receipt = D.credential_effect(ENV, read)
        self.assertEqual(receipt["access_credentials_edge_effect"],
                         "PROVEN_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS")
        self.assertEqual(receipt["authenticated_health_response_class"],
                         "JSON_NOT_WORKER_ACCESS_AUTH_SCHEMA")
        self.assertEqual(calls, 2)
        rendered = json.dumps(receipt)
        self.assertNotIn("worker-private", rendered)
        self.assertNotIn("edge-private", rendered)

    def test_no_credentials_redirect_is_bounded(self):
        calls = 0
        edge_body = json.dumps({"private": "edge-private"}).encode()

        def read(url, _token, **kwargs):
            nonlocal calls
            calls += 1
            if kwargs.get("access"):
                raise self.http_error(url, 403, edge_body)
            raise self.http_error(url, 302, b"redirect-private")

        receipt = D.credential_effect(ENV, read)
        self.assertEqual(receipt["access_credentials_edge_effect"],
                         "PROVEN_NO_CREDENTIALS_REDIRECT")
        self.assertEqual(calls, 2)
        self.assertNotIn("redirect-private", json.dumps(receipt))

    def test_contract_failures_do_not_touch_network(self):
        calls = []
        receipt = D.credential_effect({}, lambda *args, **kwargs: calls.append((args, kwargs)))
        self.assertEqual(receipt["reason"], "MAIN_DISPATCH_REQUIRED")
        self.assertEqual(calls, [])

        env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_NAME": "main", "GITHUB_SHA": "a" * 40}
        receipt = D.credential_effect(env, lambda *args, **kwargs: calls.append((args, kwargs)))
        self.assertEqual(receipt["reason"], "REQUIRED_READ_CREDENTIAL_ABSENT")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
