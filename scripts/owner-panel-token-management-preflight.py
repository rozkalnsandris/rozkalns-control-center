#!/usr/bin/env python3
"""Cross-environment, bounded GET-only proof for token-management access."""

import importlib.util
import json
import os
import pathlib
import sys

REPAIR_PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-repair.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_access_write_token_repair", REPAIR_PATH)
REPAIR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPAIR)


def empty_receipt(detail):
    return {
        "detail": detail,
        "management_access": "NOT_PROVEN",
        "production_mutations": 0,
        "request_count": 0,
        "token_kind": "NOT_PROVEN",
        "write_token_status": "NOT_PROVEN",
    }


def get_only_sender(send, requests):
    def get_only(method, url, token, body=None):
        REPAIR.require(method == "GET" and body is None, "NON_GET_METHOD_BLOCKED")
        requests.append(url)
        return send(method, url, token)

    return get_only


def identity_proof(env, send=REPAIR.default_send):
    write_token = env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN")
    receipt = empty_receipt("TOKEN_MANAGEMENT_IDENTITY_FAILED")
    if not isinstance(write_token, str) or not write_token:
        receipt["detail"] = "WRITE_TOKEN_CREDENTIAL_UNAVAILABLE"
        return receipt, None

    requests = []
    token_id = None
    try:
        token_id = REPAIR.verify_candidate(get_only_sender(send, requests), write_token)
        receipt["write_token_status"] = "PROVEN_ACTIVE"
        receipt["detail"] = "TOKEN_MANAGEMENT_IDENTITY_COMPLETE"
    except Exception as error:
        receipt["preflight_class"] = REPAIR.bounded_status(error)

    receipt["request_count"] = len(requests)
    return receipt, token_id


def management_proof(env, send=REPAIR.default_send):
    management_token = env.get("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN")
    token_id = env.get("TARGET_WRITE_TOKEN_ID")
    receipt = empty_receipt("TOKEN_MANAGEMENT_PREFLIGHT_FAILED")
    if not isinstance(management_token, str) or not management_token:
        receipt["detail"] = "MANAGEMENT_CREDENTIAL_UNAVAILABLE"
        return receipt
    if not isinstance(token_id, str) or not REPAIR.TOKEN_ID_RE.fullmatch(token_id):
        receipt["detail"] = "WRITE_TOKEN_IDENTITY_UNAVAILABLE"
        return receipt

    requests = []
    get_only = get_only_sender(send, requests)
    receipt["write_token_status"] = "BOUND_IDENTITY_OUTPUT"
    try:
        payload = get_only("GET", REPAIR.user_token_url(token_id), management_token)
        token = REPAIR.result_object(payload, "USER_TOKEN_DETAIL_INVALID")
        REPAIR.require(token.get("id") == token_id, "USER_TOKEN_DETAIL_MISMATCH")
        REPAIR.require(token.get("status") == "active", "USER_TOKEN_DETAIL_NOT_ACTIVE")
        receipt["token_kind"] = "USER_OWNED"

        REPAIR.discover_write_permission_group(get_only, management_token, "USER_OWNED")
        receipt["management_access"] = "PROVEN_USER_TOKEN_DETAILS_AND_PERMISSION_GROUP"
        receipt["detail"] = "TOKEN_MANAGEMENT_PREFLIGHT_COMPLETE"
    except Exception as error:
        receipt["preflight_class"] = REPAIR.bounded_status(error)

    receipt["request_count"] = len(requests)
    return receipt


def write_identity_output(token_id, env):
    output_path = env.get("GITHUB_OUTPUT")
    REPAIR.require(isinstance(output_path, str) and output_path, "GITHUB_OUTPUT_UNAVAILABLE")
    REPAIR.require(isinstance(token_id, str) and REPAIR.TOKEN_ID_RE.fullmatch(token_id), "WRITE_TOKEN_ID_INVALID")
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"token_id={token_id}\n")


def main(argv, env):
    mode = argv[1] if len(argv) == 2 else ""
    try:
        if mode == "--identity":
            receipt, token_id = identity_proof(env)
            if receipt["detail"] == "TOKEN_MANAGEMENT_IDENTITY_COMPLETE":
                write_identity_output(token_id, env)
                rc = 0
            else:
                rc = 1
        elif mode == "--management":
            receipt = management_proof(env)
            rc = 0 if receipt["detail"] == "TOKEN_MANAGEMENT_PREFLIGHT_COMPLETE" else 1
        else:
            receipt = empty_receipt("TOKEN_MANAGEMENT_PREFLIGHT_MODE_INVALID")
            rc = 1
    except Exception as error:
        receipt = empty_receipt("TOKEN_MANAGEMENT_PREFLIGHT_UNCLASSIFIED")
        receipt["preflight_class"] = REPAIR.bounded_status(error)
        receipt["unclassified"] = "YES"
        rc = 1
    print(json.dumps(receipt, sort_keys=True))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv, os.environ))
