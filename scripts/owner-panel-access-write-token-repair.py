#!/usr/bin/env python3
"""One-shot, fail-closed repair for the Owner Panel Cloudflare Access API write token.

The helper never rotates token values. It reads the current API-token definition,
appends one narrow allow policy for the existing Owner Panel account with
`Access: Service Tokens Write`, performs exactly one token-policy PUT, and then
verifies exact Service Token GET access with the unchanged credential.
"""

import importlib.util
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PROOF_PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-proof.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_write_token_proof", PROOF_PATH)
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)

ACCOUNT = PROOF.ACCOUNT
SERVICE_TOKEN_BASE = PROOF.BASE
VERIFY = PROOF.VERIFY
MAX_BODY = 65_536
MAX_PAGES = 10
PERMISSION_NAME = "Access: Service Tokens Write"
PERMISSION_SCOPE = "com.cloudflare.api.account"
TARGET_RESOURCE = f"com.cloudflare.api.account.{ACCOUNT}"
ALL_ACCOUNTS_RESOURCE = "com.cloudflare.api.account.*"
TOKEN_ID_RE = re.compile(r"[0-9a-f]{32}")
UUID_RE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


class ProofError(ValueError):
    pass


class ApiError(RuntimeError):
    def __init__(self, status):
        super().__init__(f"HTTP_{status}")
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(ok, code):
    if not ok:
        raise ProofError(code)


def bearer_headers(token, has_body=False):
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-store",
    }
    if has_body:
        headers["Content-Type"] = "application/json"
    return headers


def default_send(method, url, token, body=None):
    data = None
    if body is not None:
        data = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        require(len(data) <= MAX_BODY, "REQUEST_TOO_LARGE")
    request = urllib.request.Request(
        url,
        headers=bearer_headers(token, body is not None),
        data=data,
        method=method,
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            if response.status != 200:
                raise ApiError(response.status)
            raw = response.read(MAX_BODY + 1)
    except urllib.error.HTTPError as error:
        raise ApiError(error.code) from None
    require(len(raw) <= MAX_BODY, "RESPONSE_TOO_LARGE")
    return json.loads(raw.decode("utf-8"))


def result_object(payload, code):
    require(
        isinstance(payload, dict)
        and payload.get("success") is True
        and isinstance(payload.get("result"), dict),
        code,
    )
    return payload["result"]


def verify_candidate(send, write_token):
    result = result_object(send("GET", VERIFY, write_token), "WRITE_TOKEN_VERIFY_INVALID")
    require(result.get("status") == "active", "WRITE_TOKEN_NOT_ACTIVE")
    token_id = result.get("id")
    require(isinstance(token_id, str) and TOKEN_ID_RE.fullmatch(token_id), "WRITE_TOKEN_ID_INVALID")
    return token_id


def user_token_url(token_id):
    return f"https://api.cloudflare.com/client/v4/user/tokens/{token_id}"


def account_token_url(token_id):
    return f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/tokens/{token_id}"


def permission_groups_url(kind):
    query = urllib.parse.urlencode({"name": PERMISSION_NAME, "scope": PERMISSION_SCOPE})
    if kind == "USER_OWNED":
        return f"https://api.cloudflare.com/client/v4/user/tokens/permission_groups?{query}"
    return f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/tokens/permission_groups?{query}"


def discover_managed_token(send, management_token, token_id):
    user_error = None
    try:
        result = result_object(
            send("GET", user_token_url(token_id), management_token),
            "USER_TOKEN_DETAIL_INVALID",
        )
        require(result.get("id") == token_id, "USER_TOKEN_DETAIL_MISMATCH")
        return "USER_OWNED", user_token_url(token_id), result
    except ApiError as error:
        if error.status not in (403, 404):
            raise
        user_error = error.status

    try:
        result = result_object(
            send("GET", account_token_url(token_id), management_token),
            "ACCOUNT_TOKEN_DETAIL_INVALID",
        )
        require(result.get("id") == token_id, "ACCOUNT_TOKEN_DETAIL_MISMATCH")
        return "ACCOUNT_OWNED", account_token_url(token_id), result
    except ApiError as error:
        if error.status not in (403, 404):
            raise
        raise ProofError(
            "MANAGEMENT_TOKEN_DETAILS_NOT_PROVEN"
            if user_error is not None
            else "MANAGEMENT_TOKEN_DETAILS_UNAVAILABLE"
        ) from None


def discover_write_permission_group(send, management_token, kind):
    payload = send("GET", permission_groups_url(kind), management_token)
    require(
        isinstance(payload, dict)
        and payload.get("success") is True
        and isinstance(payload.get("result"), list),
        "PERMISSION_GROUP_LIST_INVALID",
    )
    matches = []
    for item in payload["result"]:
        if not isinstance(item, dict):
            continue
        if item.get("name") != PERMISSION_NAME:
            continue
        scopes = item.get("scopes")
        if not isinstance(scopes, list) or PERMISSION_SCOPE not in scopes:
            continue
        group_id = item.get("id")
        if isinstance(group_id, str) and TOKEN_ID_RE.fullmatch(group_id):
            matches.append(group_id)
    require(len(matches) == 1, "WRITE_PERMISSION_GROUP_NOT_UNIQUE")
    return matches[0]


def copy_policy(policy):
    require(isinstance(policy, dict), "TOKEN_POLICY_NOT_OBJECT")
    require(policy.get("effect") == "allow", "TOKEN_NON_ALLOW_POLICY_PRESENT")
    groups = policy.get("permission_groups")
    resources = policy.get("resources")
    require(isinstance(groups, list), "TOKEN_PERMISSION_GROUPS_INVALID")
    require(isinstance(resources, dict), "TOKEN_RESOURCES_INVALID")
    copied_groups = []
    for group in groups:
        require(isinstance(group, dict), "TOKEN_PERMISSION_GROUP_INVALID")
        group_id = group.get("id")
        require(isinstance(group_id, str) and TOKEN_ID_RE.fullmatch(group_id), "TOKEN_PERMISSION_GROUP_ID_INVALID")
        copied_groups.append({"id": group_id})
    # Round-trip through JSON to prove the resource structure is bounded/serializable.
    copied_resources = json.loads(json.dumps(resources, sort_keys=True))
    require(isinstance(copied_resources, dict), "TOKEN_RESOURCES_INVALID")
    return {
        "effect": "allow",
        "permission_groups": copied_groups,
        "resources": copied_resources,
    }


def policy_grants_target_write(policy, write_group_id):
    if policy.get("effect") != "allow":
        return False
    groups = policy.get("permission_groups")
    resources = policy.get("resources")
    if not isinstance(groups, list) or not isinstance(resources, dict):
        return False
    has_group = any(isinstance(group, dict) and group.get("id") == write_group_id for group in groups)
    if not has_group:
        return False
    return resources.get(TARGET_RESOURCE) == "*" or resources.get(ALL_ACCOUNTS_RESOURCE) == "*"


def build_update_body(token, token_id, write_group_id):
    require(isinstance(token, dict) and token.get("id") == token_id, "TOKEN_DETAIL_MISMATCH")
    require(token.get("status") == "active", "TOKEN_DETAIL_NOT_ACTIVE")
    name = token.get("name")
    policies = token.get("policies")
    require(isinstance(name, str) and 1 <= len(name) <= 120, "TOKEN_NAME_INVALID")
    require(isinstance(policies, list) and len(policies) <= 50, "TOKEN_POLICIES_INVALID")
    require(not any(isinstance(policy, dict) and policy.get("effect") == "deny" for policy in policies), "TOKEN_DENY_POLICY_PRESENT")
    require(not any(policy_grants_target_write(policy, write_group_id) for policy in policies), "TARGET_WRITE_POLICY_ALREADY_PRESENT")

    copied = [copy_policy(policy) for policy in policies]
    require(len(copied) < 50, "TOKEN_POLICY_LIMIT_REACHED")
    copied.append(
        {
            "effect": "allow",
            "permission_groups": [{"id": write_group_id}],
            "resources": {TARGET_RESOURCE: "*"},
        }
    )

    body = {"name": name, "policies": copied, "status": "active"}
    for key in ("condition", "expires_on", "not_before"):
        if token.get(key) is not None:
            body[key] = token[key]
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    require(len(encoded) <= MAX_BODY, "TOKEN_UPDATE_BODY_TOO_LARGE")
    return body


def updated_result_valid(payload, token_id, write_group_id):
    result = result_object(payload, "TOKEN_UPDATE_RESPONSE_INVALID")
    require(result.get("id") == token_id, "TOKEN_UPDATE_TARGET_MISMATCH")
    require(result.get("status") == "active", "TOKEN_UPDATE_STATUS_INVALID")
    policies = result.get("policies")
    require(isinstance(policies, list), "TOKEN_UPDATE_POLICIES_INVALID")
    require(any(policy_grants_target_write(policy, write_group_id) for policy in policies), "TOKEN_UPDATE_POLICY_NOT_PROVEN")


def find_service_token_id(send, read_token, client_id):
    require(isinstance(client_id, str) and 1 <= len(client_id) <= 128, "CLIENT_ID_INVALID")
    matches = []
    for page in range(1, MAX_PAGES + 1):
        url = f"{SERVICE_TOKEN_BASE}?per_page=100&page={page}"
        payload = send("GET", url, read_token)
        require(
            isinstance(payload, dict)
            and payload.get("success") is True
            and isinstance(payload.get("result"), list),
            "SERVICE_TOKEN_LIST_INVALID",
        )
        rows = payload["result"]
        require(len(rows) <= 100, "SERVICE_TOKEN_LIST_PAGE_TOO_LARGE")
        for row in rows:
            require(isinstance(row, dict), "SERVICE_TOKEN_LIST_ROW_INVALID")
            if row.get("client_id") == client_id:
                matches.append(row)
        if len(rows) < 100:
            break
    require(len(matches) == 1, "SERVICE_TOKEN_TARGET_NOT_UNIQUE")
    token_id = matches[0].get("id")
    require(isinstance(token_id, str) and UUID_RE.fullmatch(token_id), "SERVICE_TOKEN_TARGET_ID_INVALID")
    return token_id


def exact_target_access(send, read_token, write_token, client_id):
    token_id = find_service_token_id(send, read_token, client_id)
    try:
        payload = send("GET", f"{SERVICE_TOKEN_BASE}/{token_id}", write_token)
    except ApiError as error:
        if error.status in (401, 403, 404):
            return f"HTTP_{error.status}"
        return "HTTP_OTHER"
    result = result_object(payload, "SERVICE_TOKEN_EXACT_GET_INVALID")
    require(result.get("id") == token_id, "SERVICE_TOKEN_EXACT_GET_TARGET_MISMATCH")
    require(result.get("client_id") == client_id, "SERVICE_TOKEN_EXACT_GET_CLIENT_MISMATCH")
    enabled = result.get("enabled")
    require(enabled is None or type(enabled) is bool, "SERVICE_TOKEN_ENABLED_INVALID")
    require(enabled is not False, "SERVICE_TOKEN_DISABLED")
    return "PROVEN_EXACT_GET"


def empty_receipt(detail):
    return {
        "detail": detail,
        "exact_target_access_after": "NOT_CHECKED",
        "github_secret_update": "NOT_PERFORMED",
        "management_access": "NOT_PROVEN",
        "mutation_started": False,
        "permission_patch": "NOT_STARTED",
        "production_mutations": 0,
        "token_kind": "NOT_PROVEN",
        "write_token_status": "NOT_PROVEN",
    }


def bounded_status(error):
    if isinstance(error, ApiError):
        if error.status in (401, 403, 404):
            return f"HTTP_{error.status}"
        return "HTTP_OTHER"
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        return "REQUEST_FAILED"
    if isinstance(error, (json.JSONDecodeError, UnicodeDecodeError)):
        return "RESPONSE_NOT_JSON"
    if isinstance(error, ProofError):
        return str(error)
    return "UNCLASSIFIED_FAILURE"


def repair(env, send=default_send):
    management_token = env.get("CLOUDFLARE_API_TOKEN")
    write_token = env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN")
    read_token = env.get("CLOUDFLARE_ACCESS_READ_TOKEN")
    client_id = env.get("CONTROL_ACCESS_CLIENT_ID")
    receipt = empty_receipt("ACCESS_WRITE_TOKEN_SCOPE_REPAIR_PREFLIGHT_FAILED")
    if not all(isinstance(value, str) and value for value in (management_token, write_token, read_token, client_id)):
        receipt["detail"] = "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_CREDENTIAL_UNAVAILABLE"
        return receipt

    try:
        token_id = verify_candidate(send, write_token)
        receipt["write_token_status"] = "PROVEN_ACTIVE"
        kind, update_url, token = discover_managed_token(send, management_token, token_id)
        receipt["token_kind"] = kind
        write_group_id = discover_write_permission_group(send, management_token, kind)
        receipt["management_access"] = "PROVEN_TOKEN_DETAILS_AND_PERMISSION_GROUP"
        body = build_update_body(token, token_id, write_group_id)
    except Exception as error:
        receipt["detail"] = "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_PREFLIGHT_FAILED"
        receipt["preflight_class"] = bounded_status(error)
        return receipt

    receipt["permission_patch"] = "NARROW_ACCOUNT_WRITE_POLICY_PREPARED"
    receipt["mutation_started"] = True
    try:
        update_payload = send("PUT", update_url, management_token, body)
        updated_result_valid(update_payload, token_id, write_group_id)
    except Exception as error:
        receipt["detail"] = "TOKEN_POLICY_UPDATE_STATE_UNCERTAIN"
        receipt["production_mutations"] = "YES_OR_UNCERTAIN"
        receipt["mutation_failure_class"] = bounded_status(error)
        return receipt

    receipt["production_mutations"] = 1
    receipt["permission_patch"] = "NARROW_ACCOUNT_WRITE_POLICY_APPENDED"
    receipt["github_secret_update"] = "NOT_REQUIRED_TOKEN_VALUE_UNCHANGED"

    try:
        receipt["exact_target_access_after"] = exact_target_access(
            send, read_token, write_token, client_id
        )
    except Exception as error:
        receipt["detail"] = "TOKEN_POLICY_UPDATE_APPLIED_VERIFY_FAILED"
        receipt["verify_failure_class"] = bounded_status(error)
        return receipt

    if receipt["exact_target_access_after"] != "PROVEN_EXACT_GET":
        receipt["detail"] = "TOKEN_POLICY_UPDATE_APPLIED_VERIFY_FAILED"
        return receipt

    receipt["detail"] = "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_COMPLETE"
    return receipt


def main(env):
    try:
        receipt = repair(env)
    except Exception:
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_SCOPE_REPAIR_UNCLASSIFIED")
        receipt["unclassified"] = "YES"
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
