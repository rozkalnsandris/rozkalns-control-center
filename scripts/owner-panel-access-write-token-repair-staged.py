#!/usr/bin/env python3
"""Staged, fail-closed Access write-token repair across GitHub environment boundaries."""

import importlib.util
import json
import os
import pathlib
import sys

CORE_PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-repair.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_access_write_token_repair", CORE_PATH)
CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORE)


def empty_receipt(detail):
    return {
        "detail": detail,
        "exact_target_access_after": "NOT_CHECKED",
        "exact_target_access_before": "NOT_CHECKED",
        "github_secret_update": "NOT_PERFORMED",
        "management_access": "NOT_PROVEN",
        "mutation_started": False,
        "permission_patch": "NOT_STARTED",
        "production_mutations": 0,
        "request_count": 0,
        "token_kind": "NOT_PROVEN",
        "write_token_status": "NOT_PROVEN",
    }


def get_only_sender(send, requests):
    def get_only(method, url, token, body=None):
        CORE.require(method == "GET" and body is None, "NON_GET_METHOD_BLOCKED")
        requests.append((method, url))
        return send(method, url, token)

    return get_only


def readonly_preflight(env, send=CORE.default_send):
    write_token = env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN")
    read_token = env.get("CLOUDFLARE_ACCESS_READ_TOKEN")
    client_id = env.get("CONTROL_ACCESS_CLIENT_ID")
    receipt = empty_receipt("ACCESS_WRITE_TOKEN_REPAIR_READONLY_PREFLIGHT_FAILED")
    if not all(isinstance(value, str) and value for value in (write_token, read_token, client_id)):
        receipt["detail"] = "ACCESS_WRITE_TOKEN_REPAIR_READONLY_CREDENTIAL_UNAVAILABLE"
        return receipt, None

    requests = []
    get_only = get_only_sender(send, requests)
    token_id = None
    try:
        token_id = CORE.verify_candidate(get_only, write_token)
        receipt["write_token_status"] = "PROVEN_ACTIVE"
        receipt["exact_target_access_before"] = CORE.exact_target_access(
            get_only, read_token, write_token, client_id
        )
        CORE.require(
            receipt["exact_target_access_before"] == "HTTP_403",
            "EXACT_TARGET_PRECONDITION_NOT_HTTP_403",
        )
        receipt["detail"] = "ACCESS_WRITE_TOKEN_REPAIR_READONLY_PREFLIGHT_COMPLETE"
    except Exception as error:
        receipt["preflight_class"] = CORE.bounded_status(error)
        token_id = None

    receipt["request_count"] = len(requests)
    return receipt, token_id


def management_put(env, send=CORE.default_send):
    management_token = env.get("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN")
    token_id = env.get("TARGET_WRITE_TOKEN_ID")
    receipt = empty_receipt("ACCESS_WRITE_TOKEN_SCOPE_REPAIR_PREFLIGHT_FAILED")
    if not isinstance(management_token, str) or not management_token:
        receipt["detail"] = "TOKEN_MANAGEMENT_CREDENTIAL_UNAVAILABLE"
        return receipt
    if not isinstance(token_id, str) or not CORE.TOKEN_ID_RE.fullmatch(token_id):
        receipt["detail"] = "WRITE_TOKEN_IDENTITY_UNAVAILABLE"
        return receipt

    requests = []

    def bounded_send(method, url, token, body=None):
        if method == "GET":
            CORE.require(body is None, "GET_BODY_BLOCKED")
        elif method == "PUT":
            CORE.require(url == CORE.user_token_url(token_id), "PUT_TARGET_BLOCKED")
            CORE.require(isinstance(body, dict), "PUT_BODY_REQUIRED")
        else:
            raise CORE.ProofError("METHOD_BLOCKED")
        requests.append((method, url))
        return send(method, url, token, body)

    try:
        payload = bounded_send("GET", CORE.user_token_url(token_id), management_token)
        token = CORE.result_object(payload, "USER_TOKEN_DETAIL_INVALID")
        CORE.require(token.get("id") == token_id, "USER_TOKEN_DETAIL_MISMATCH")
        CORE.require(token.get("status") == "active", "USER_TOKEN_DETAIL_NOT_ACTIVE")
        receipt["token_kind"] = "USER_OWNED"
        write_group_id = CORE.discover_write_permission_group(
            bounded_send, management_token, "USER_OWNED"
        )
        receipt["management_access"] = "PROVEN_USER_TOKEN_DETAILS_AND_PERMISSION_GROUP"
        body = CORE.build_update_body(token, token_id, write_group_id)
    except Exception as error:
        receipt["preflight_class"] = CORE.bounded_status(error)
        receipt["request_count"] = len(requests)
        return receipt

    receipt["permission_patch"] = "NARROW_ACCOUNT_WRITE_POLICY_PREPARED"
    receipt["mutation_started"] = True
    try:
        update_payload = bounded_send(
            "PUT", CORE.user_token_url(token_id), management_token, body
        )
        CORE.updated_result_valid(update_payload, token_id, write_group_id)
    except Exception as error:
        receipt["detail"] = "TOKEN_POLICY_UPDATE_STATE_UNCERTAIN"
        receipt["production_mutations"] = "YES_OR_UNCERTAIN"
        receipt["mutation_failure_class"] = CORE.bounded_status(error)
        receipt["request_count"] = len(requests)
        return receipt

    receipt["detail"] = "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_MUTATION_COMPLETE"
    receipt["production_mutations"] = 1
    receipt["permission_patch"] = "NARROW_ACCOUNT_WRITE_POLICY_APPENDED"
    receipt["github_secret_update"] = "NOT_REQUIRED_TOKEN_VALUE_UNCHANGED"
    receipt["request_count"] = len(requests)
    return receipt


def readonly_postverify(env, send=CORE.default_send):
    write_token = env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN")
    read_token = env.get("CLOUDFLARE_ACCESS_READ_TOKEN")
    client_id = env.get("CONTROL_ACCESS_CLIENT_ID")
    expected_token_id = env.get("TARGET_WRITE_TOKEN_ID")
    receipt = empty_receipt("ACCESS_WRITE_TOKEN_REPAIR_POSTVERIFY_FAILED")
    if not all(isinstance(value, str) and value for value in (write_token, read_token, client_id)):
        receipt["detail"] = "ACCESS_WRITE_TOKEN_REPAIR_READONLY_CREDENTIAL_UNAVAILABLE"
        return receipt
    if not isinstance(expected_token_id, str) or not CORE.TOKEN_ID_RE.fullmatch(expected_token_id):
        receipt["detail"] = "WRITE_TOKEN_IDENTITY_UNAVAILABLE"
        return receipt

    requests = []
    get_only = get_only_sender(send, requests)
    try:
        current_token_id = CORE.verify_candidate(get_only, write_token)
        CORE.require(current_token_id == expected_token_id, "WRITE_TOKEN_IDENTITY_DRIFT")
        receipt["write_token_status"] = "PROVEN_ACTIVE"
        receipt["exact_target_access_after"] = CORE.exact_target_access(
            get_only, read_token, write_token, client_id
        )
        CORE.require(
            receipt["exact_target_access_after"] == "PROVEN_EXACT_GET",
            "POSTVERIFY_EXACT_TARGET_NOT_PROVEN",
        )
        receipt["detail"] = "ACCESS_WRITE_TOKEN_REPAIR_POSTVERIFY_COMPLETE"
    except Exception as error:
        receipt["verify_failure_class"] = CORE.bounded_status(error)

    receipt["request_count"] = len(requests)
    return receipt


def write_token_id_output(token_id, env):
    output_path = env.get("GITHUB_OUTPUT")
    CORE.require(isinstance(output_path, str) and output_path, "GITHUB_OUTPUT_UNAVAILABLE")
    CORE.require(isinstance(token_id, str) and CORE.TOKEN_ID_RE.fullmatch(token_id), "WRITE_TOKEN_ID_INVALID")
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"token_id={token_id}\n")


def main(argv, env):
    mode = argv[1] if len(argv) == 2 else ""
    try:
        if mode == "--readonly-preflight":
            receipt, token_id = readonly_preflight(env)
            if receipt["detail"] == "ACCESS_WRITE_TOKEN_REPAIR_READONLY_PREFLIGHT_COMPLETE":
                write_token_id_output(token_id, env)
                rc = 0
            else:
                rc = 1
        elif mode == "--management-put":
            receipt = management_put(env)
            rc = 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_SCOPE_REPAIR_MUTATION_COMPLETE" else 1
        elif mode == "--readonly-postverify":
            receipt = readonly_postverify(env)
            rc = 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_REPAIR_POSTVERIFY_COMPLETE" else 1
        else:
            receipt = empty_receipt("ACCESS_WRITE_TOKEN_REPAIR_STAGE_INVALID")
            rc = 1
    except Exception as error:
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_REPAIR_STAGE_UNCLASSIFIED")
        receipt["stage_failure_class"] = CORE.bounded_status(error)
        receipt["unclassified"] = "YES"
        rc = 1
    print(json.dumps(receipt, sort_keys=True))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv, os.environ))
