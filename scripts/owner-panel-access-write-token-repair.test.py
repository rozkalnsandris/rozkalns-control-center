#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import unittest

PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-repair.py")
SPEC = importlib.util.spec_from_file_location("access_write_token_repair", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "a" * 32
WRITE_GROUP_ID = "b" * 32
OTHER_GROUP_ID = "c" * 32
POLICY_ID = "d" * 32
SERVICE_ID = "3537a672-e4d8-4d89-aab9-26cb622918a1"
CLIENT_ID = "88bf3b6d86161464f6509f7219099e57.access"


def verify_payload():
    return {"success": True, "result": {"id": TOKEN_ID, "status": "active"}}


def token_detail(extra_policies=None):
    policies = [
        {
            "id": POLICY_ID,
            "effect": "allow",
            "permission_groups": [{"id": OTHER_GROUP_ID, "name": "Workers Scripts Read"}],
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
                "name": MOD.PERMISSION_NAME,
                "scopes": [MOD.PERMISSION_SCOPE],
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


class AccessWriteTokenRepairTests(unittest.TestCase):
    def env(self):
        return {
            "CLOUDFLARE_API_TOKEN": "management-secret",
            "CLOUDFLARE_ACCESS_WRITE_TOKEN": "write-secret",
            "CLOUDFLARE_ACCESS_READ_TOKEN": "read-secret",
            "CONTROL_ACCESS_CLIENT_ID": CLIENT_ID,
        }

    def test_user_owned_token_repairs_with_exactly_one_put(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url, token, body))
            if method == "GET" and url == MOD.VERIFY:
                return verify_payload()
            if method == "GET" and url == MOD.user_token_url(TOKEN_ID):
                return token_detail()
            if method == "GET" and url.startswith("https://api.cloudflare.com/client/v4/user/tokens/permission_groups?"):
                return permission_groups_payload()
            if method == "PUT" and url == MOD.user_token_url(TOKEN_ID):
                return updated_payload(body)
            if method == "GET" and url.startswith(MOD.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if method == "GET" and url == f"{MOD.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                return exact_service_payload()
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_COMPLETE")
        self.assertEqual(receipt["token_kind"], "USER_OWNED")
        self.assertEqual(receipt["production_mutations"], 1)
        self.assertEqual(receipt["exact_target_access_after"], "PROVEN_EXACT_GET")
        self.assertEqual(receipt["github_secret_update"], "NOT_REQUIRED_TOKEN_VALUE_UNCHANGED")
        puts = [call for call in calls if call[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        new_policy = puts[0][3]["policies"][-1]
        self.assertEqual(new_policy["permission_groups"], [{"id": WRITE_GROUP_ID}])
        self.assertEqual(new_policy["resources"], {MOD.TARGET_RESOURCE: "*"})

    def test_account_owned_token_uses_account_management_endpoint(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url, token, body))
            if method == "GET" and url == MOD.VERIFY:
                return verify_payload()
            if method == "GET" and url == MOD.user_token_url(TOKEN_ID):
                raise MOD.ApiError(404)
            if method == "GET" and url == MOD.account_token_url(TOKEN_ID):
                return token_detail()
            if method == "GET" and "/tokens/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT" and url == MOD.account_token_url(TOKEN_ID):
                return updated_payload(body)
            if method == "GET" and url.startswith(MOD.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if method == "GET" and url == f"{MOD.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                return exact_service_payload()
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertEqual(receipt["detail"], "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_COMPLETE")
        self.assertEqual(receipt["token_kind"], "ACCOUNT_OWNED")
        puts = [call for call in calls if call[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][1], MOD.account_token_url(TOKEN_ID))

    def test_existing_target_write_policy_stops_before_mutation(self):
        calls = []
        existing = {
            "effect": "allow",
            "permission_groups": [{"id": WRITE_GROUP_ID}],
            "resources": {MOD.TARGET_RESOURCE: "*"},
        }

        def send(method, url, token, body=None):
            calls.append((method, url))
            if url == MOD.VERIFY:
                return verify_payload()
            if url == MOD.user_token_url(TOKEN_ID):
                return token_detail([existing])
            if "/permission_groups?" in url:
                return permission_groups_payload()
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertFalse(receipt["mutation_started"])
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertEqual(receipt["preflight_class"], "TARGET_WRITE_POLICY_ALREADY_PRESENT")
        self.assertNotIn("PUT", [method for method, _ in calls])

    def test_deny_policy_stops_before_mutation(self):
        calls = []
        deny = {
            "effect": "deny",
            "permission_groups": [{"id": WRITE_GROUP_ID}],
            "resources": {MOD.TARGET_RESOURCE: "*"},
        }

        def send(method, url, token, body=None):
            calls.append((method, url))
            if url == MOD.VERIFY:
                return verify_payload()
            if url == MOD.user_token_url(TOKEN_ID):
                return token_detail([deny])
            if "/permission_groups?" in url:
                return permission_groups_payload()
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertFalse(receipt["mutation_started"])
        self.assertEqual(receipt["preflight_class"], "TOKEN_DENY_POLICY_PRESENT")
        self.assertNotIn("PUT", [method for method, _ in calls])

    def test_management_access_not_proven_stops_before_mutation(self):
        calls = []

        def send(method, url, token, body=None):
            calls.append((method, url))
            if url == MOD.VERIFY:
                return verify_payload()
            if url in (MOD.user_token_url(TOKEN_ID), MOD.account_token_url(TOKEN_ID)):
                raise MOD.ApiError(403)
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertFalse(receipt["mutation_started"])
        self.assertEqual(receipt["preflight_class"], "MANAGEMENT_TOKEN_DETAILS_NOT_PROVEN")
        self.assertNotIn("PUT", [method for method, _ in calls])

    def test_put_failure_is_uncertain_and_never_retried(self):
        puts = 0

        def send(method, url, token, body=None):
            nonlocal puts
            if url == MOD.VERIFY:
                return verify_payload()
            if method == "GET" and url == MOD.user_token_url(TOKEN_ID):
                return token_detail()
            if "/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT":
                puts += 1
                raise MOD.ApiError(500)
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertTrue(receipt["mutation_started"])
        self.assertEqual(receipt["detail"], "TOKEN_POLICY_UPDATE_STATE_UNCERTAIN")
        self.assertEqual(receipt["production_mutations"], "YES_OR_UNCERTAIN")
        self.assertEqual(puts, 1)

    def test_post_put_exact_get_403_stops_without_retry_or_rollback(self):
        puts = 0

        def send(method, url, token, body=None):
            nonlocal puts
            if url == MOD.VERIFY:
                return verify_payload()
            if method == "GET" and url == MOD.user_token_url(TOKEN_ID):
                return token_detail()
            if "/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT":
                puts += 1
                return updated_payload(body)
            if url.startswith(MOD.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                raise MOD.ApiError(403)
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        self.assertEqual(receipt["detail"], "TOKEN_POLICY_UPDATE_APPLIED_VERIFY_FAILED")
        self.assertEqual(receipt["production_mutations"], 1)
        self.assertEqual(receipt["exact_target_access_after"], "HTTP_403")
        self.assertEqual(puts, 1)

    def test_receipt_never_contains_credentials_or_identifiers(self):
        def send(method, url, token, body=None):
            if url == MOD.VERIFY:
                return verify_payload()
            if method == "GET" and url == MOD.user_token_url(TOKEN_ID):
                return token_detail()
            if "/permission_groups?" in url:
                return permission_groups_payload()
            if method == "PUT":
                return updated_payload(body)
            if url.startswith(MOD.SERVICE_TOKEN_BASE + "?per_page="):
                return read_list_payload()
            if url == f"{MOD.SERVICE_TOKEN_BASE}/{SERVICE_ID}":
                return exact_service_payload()
            raise AssertionError((method, url))

        receipt = MOD.repair(self.env(), send)
        encoded = json.dumps(receipt, sort_keys=True)
        for forbidden in (
            "management-secret",
            "write-secret",
            "read-secret",
            CLIENT_ID,
            TOKEN_ID,
            SERVICE_ID,
            MOD.ACCOUNT,
        ):
            self.assertNotIn(forbidden, encoded)


if __name__ == "__main__":
    unittest.main()
