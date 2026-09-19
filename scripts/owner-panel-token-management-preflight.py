#!/usr/bin/env python3
"""Bounded GET-only proof for the dedicated user API-token management credential."""

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


def proof(env, send=REPAIR.default_send):
    management_token = env.get("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN")
    write_token = env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN")
    receipt = empty_receipt("TOKEN_MANAGEMENT_PREFLIGHT_FAILED")
    if not all(isinstance(value, str) and value for value in (management_token, write_token)):
        receipt["detail"] = "TOKEN_MANAGEMENT_CREDENTIAL_UNAVAILABLE"
        return receipt

    requests = []

    def get_only(method, url, token, body=None):
        REPAIR.require(method == "GET" and body is None, "NON_GET_METHOD_BLOCKED")
        requests.append(url)
        return send(method, url, token)

    try:
        token_id = REPAIR.verify_candidate(get_only, write_token)
        receipt["write_token_status"] = "PROVEN_ACTIVE"

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


def main(env):
    try:
        receipt = proof(env)
    except Exception:
        receipt = empty_receipt("TOKEN_MANAGEMENT_PREFLIGHT_UNCLASSIFIED")
        receipt["unclassified"] = "YES"
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "TOKEN_MANAGEMENT_PREFLIGHT_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
