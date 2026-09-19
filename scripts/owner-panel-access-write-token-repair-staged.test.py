#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import unittest

PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-repair-staged.py")
SPEC = importlib.util.spec_from_file_location("access_write_token_repair_staged", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "a" * 32
WRITE_GROUP_ID = "b" * 32
OTHER_GROUP_ID = "c" * 32
SERVICE_ID = "3537a672-e4d8-4d89-aab9-26cb622918a1"
CLIENT_ID = "88bf3b6d86161464f6509f7219099e57.access"
WRITE_TOKEN = "write-secret"
READ_TOKEN = "read-secret"
MANAGEMENT_TOKEN = "management-secret"


def verify_payload():
    return {"success": True, "result": {"id": TOKEN_ID, "status": "active"}}


def token_detail(extra_policies=None):
    policies = [
        {
            "effect": "allow",
            "permission_groups": [{"id": OTHER_GROUP_ID}],
            "resources": {"com.cloudflare.api.account.other": "*"},
        }
    ]
    if extra_policies:
        policies.extend(extra_policies)
    return {
        "success": True,
        "result": {
            "id": TOKEN_ID,
            "name": "owner-panel-access-write",
            "status": "active",
            "policies": policies,
        },
    }


def permission_groups_payload():
    return {
        "success": True,
        "result": [
            {
                "id": WRITE_GROUP_ID,
                "name": MOD.CORE.PERMISSION_NAME,
                "scopes": [MOD.CORE.PERMISSION_SCOPE],
            }
        ],
    }


def read_list_payload():
    return {
        "success": True,
        "result": [{"id": SERVICE_ID, "client_id": CLIENT_ID, "enabled": True}],
    }


def exact_service_payload():
    return {
        "success": True,
        "result": {"id": SERVICE_ID, "client_id": CLIENT_ID, "enabled": True},
    }


def updated_payload(body):
    result = dict(body)
    result["id"] = TOKEN_ID
    return {"success": True, "result": result}


def readonly_env():
    return {
        "CLOUDFLARE_ACCESS_WRITE_TOKEN": WRITE_TOKEN,
        "CLOUDFLARE_ACCESS_READ_TOKEN": READ_TOKEN,
        "CONTROL_ACCESS_CLIENT_ID": CLIENT_ID,
        "TARGET_WRITE_TOKEN_ID": TOKEN_ID,
    }


def management_env():
    return {
        "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
        "TARGET_WRITE_TOKEN_ID": TOKEN_ID,
    }


class StagedRepairTests(unittest.TestCase):
    def test_readonly_preflight_binds_active_token_and_exact_403(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url, token, body))
            if url == MOD.CORE.VERIFY:
                return verify_payload()
            if url.startswith(MOD.CORE.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.CORE.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                raise MOD.CORE.ApiError(403)
            raise AssertionError((method, url))

        receipt, token_id = MOD.readonly_preflight(readonly_env(), send)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_REPAIR_READONLY_PREFLIGHT_COMPLETE")
        self.assertEqual(receipt["write_token_status"], "PROVEN_ACTIVE")
        self.assertEqual(receipt["exact_target_access_before"], "HTTP_403")
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertEqual(token_id, TOKEN_ID)
        self.assertTrue(all(call[0] == "GET" for call in calls))

    def test_readonly_preflight_stops_if_target_already_accessible(self):
        def send(method, url, token, body=None):
            if url == MOD.CORE.VERIFY:
                return verify_payload()
            if url.startswith(MOD.CORE.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.CORE.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                return exact_service_payload()
            raise AssertionError((method, url))

        receipt, token_id = MOD.readonly_preflight(readonly_env(), send)
        self.assertEqual(receipt["preflight_class"], "EXACT_TARGET_PRECONDITION_NOT_HTTP_403")
        self.assertIsNone(token_id)
        self.assertEqual(receipt["production_mutations"], 0)

    def test_management_put_is_user_owned_and_exactly_one_put(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url, token, body))
            if method == "GET" and url == MOD.CORE.user_token_url(TOKEN_ID):
                return token_detail()
            if method == "GET" and url.startswith("https://api.cloudflare.com/client/v4/user/tokens/permission_groups?"):
                return permission_groups_payload()
            if method == "PUT" and url == MOD.CORE.user_token_url(TOKEN_ID):
                return updated_payload(body)
            raise AssertionError((method, url))

        receipt = MOD.management_put(management_env(), send)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_MUTATION_COMPLETE")
        self.assertEqual(receipt["token_kind"], "USER_OWNED")
        self.assertEqual(receipt["production_mutations"], 1)
        self.assertEqual(receipt["permission_patch"], "NARROW_ACCOUNT_WRITE_POLICY_APPENDED")
        puts = [call for call in calls if call[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertFalse(any("/accounts/" in call[1] for call in calls))

    def test_management_existing_policy_stops_before_put(self):
        target_policy = {
            "effect": "allow",
            "permission_groups": [{"id": WRITE_GROUP_ID}],
            "resources": {MOD.CORE.TARGET_RESOURCE: "*"},
        }
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url))
            if url == MOD.CORE.user_token_url(TOKEN_ID):
                return token_detail([target_policy])
            if "/permission_groups?" in url:
                return permission_groups_payload()
            raise AssertionError((method, url))

        receipt = MOD.management_put(management_env(), send)
        self.assertFalse(receipt["mutation_started"])
        self.assertEqual(receipt["preflight_class"], "TARGET_WRITE_POLICY_ALREADY_PRESENT")
        self.assertNotIn("PUT", [method for method, _ in calls])

    def test_management_put_failure_is_uncertain_and_not_retried(self):
        puts = 0

        def send(method, url, token, body=None):
            nonlocal puts
            if method == "GET" and url == MOD.CORE.user_token_url(TOKEN_ID):
                return token_detail()
            if method == "GET" and "/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT":
                puts += 1
                raise MOD.CORE.ApiError(500)
            raise AssertionError((method, url))

        receipt = MOD.management_put(management_env(), send)
        self.assertTrue(receipt["mutation_started"])
        self.assertEqual(receipt["detail"], "TOKEN_POLICY_UPDATE_STATE_UNCERTAIN")
        self.assertEqual(receipt["production_mutations"], "YES_OR_UNCERTAIN")
        self.assertEqual(puts, 1)

    def test_readonly_postverify_proves_exact_get(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url))
            if url == MOD.CORE.VERIFY:
                return verify_payload()
            if url.startswith(MOD.CORE.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.CORE.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                return exact_service_payload()
            raise AssertionError((method, url))

        receipt = MOD.readonly_postverify(readonly_env(), send)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_REPAIR_POSTVERIFY_COMPLETE")
        self.assertEqual(receipt["exact_target_access_after"], "PROVEN_EXACT_GET")
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertTrue(all(method == "GET" for method, _ in calls))

    def test_readonly_postverify_403_fails_without_mutation(self):
        def send(method, url, token, body=None):
            if url == MOD.CORE.VERIFY:
                return verify_payload()
            if url.startswith(MOD.CORE.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.CORE.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                raise MOD.CORE.ApiError(403)
            raise AssertionError((method, url))

        receipt = MOD.readonly_postverify(readonly_env(), send)
        self.assertEqual(receipt["verify_failure_class"], "POSTVERIFY_EXACT_TARGET_NOT_PROVEN")
        self.assertEqual(receipt["exact_target_access_after"], "HTTP_403")
        self.assertEqual(receipt["production_mutations"], 0)

    def test_receipts_never_contain_credentials_or_identifiers(self):
        def management_send(method, url, token, body=None):
            if method == "GET" and url == MOD.CORE.user_token_url(TOKEN_ID):
                return token_detail()
            if method == "GET" and "/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT":
                return updated_payload(body)
            raise AssertionError((method, url))

        encoded = json.dumps(MOD.management_put(management_env(), management_send), sort_keys=True)
        for forbidden in (MANAGEMENT_TOKEN, WRITE_TOKEN, READ_TOKEN, CLIENT_ID, TOKEN_ID, SERVICE_ID, MOD.CORE.ACCOUNT):
            self.assertNotIn(forbidden, encoded)


if __name__ == "__main__":
    unittest.main()
