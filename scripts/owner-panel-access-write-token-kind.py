#!/usr/bin/env python3
"""Classify the protected Access write API token ownership without exposing it.

New Cloudflare user and account API tokens have distinct scannable prefixes. This
helper uses only that bounded format hint to select the matching verify endpoint,
then proves the same credential is active. Legacy/unprefixed tokens remain
unclassified and make no network request.
"""

import importlib.util
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

PROOF_PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-proof.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_write_token_proof", PROOF_PATH)
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)

ACCOUNT = PROOF.ACCOUNT
USER_VERIFY = PROOF.VERIFY
ACCOUNT_VERIFY = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/tokens/verify"
MAX_BODY = 65_536
TOKEN_ID_RE = re.compile(r"[0-9a-f]{32}")


class ApiError(RuntimeError):
    def __init__(self, status):
        super().__init__(f"HTTP_{status}")
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def default_read(url, token):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": "Bearer " + token,
            "Cache-Control": "no-store",
        },
        method="GET",
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            if response.status != 200:
                raise ApiError(response.status)
            raw = response.read(MAX_BODY + 1)
    except urllib.error.HTTPError as error:
        raise ApiError(error.code) from None
    if len(raw) > MAX_BODY:
        raise ValueError("RESPONSE_TOO_LARGE")
    return json.loads(raw.decode("utf-8"))


def empty_receipt(detail):
    return {
        "detail": detail,
        "format_kind_hint": "NOT_PROVEN",
        "network_requests": 0,
        "production_mutations": 0,
        "secret_value_exposed": False,
        "token_kind": "NOT_PROVEN",
        "token_status": "NOT_PROVEN",
        "verification_endpoint": "NOT_RUN",
    }


def bounded_failure(error):
    if isinstance(error, ApiError):
        if error.status in (401, 403, 404):
            return f"HTTP_{error.status}"
        return "HTTP_OTHER"
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        return "REQUEST_FAILED"
    if isinstance(error, (json.JSONDecodeError, UnicodeDecodeError)):
        return "RESPONSE_NOT_JSON"
    if isinstance(error, ValueError):
        return str(error) if str(error) in {"RESPONSE_TOO_LARGE"} else "CONTRACT_UNPROVEN"
    return "UNCLASSIFIED_FAILURE"


def classify(write_token, read=default_read):
    receipt = empty_receipt("ACCESS_WRITE_TOKEN_KIND_UNPROVEN")
    if not isinstance(write_token, str) or not write_token:
        receipt["detail"] = "ACCESS_WRITE_TOKEN_CREDENTIAL_UNAVAILABLE"
        return receipt

    if write_token.startswith("cfut_"):
        expected_kind = "USER_OWNED"
        verify_url = USER_VERIFY
        receipt["verification_endpoint"] = "USER_VERIFY"
    elif write_token.startswith("cfat_"):
        expected_kind = "ACCOUNT_OWNED"
        verify_url = ACCOUNT_VERIFY
        receipt["verification_endpoint"] = "ACCOUNT_VERIFY"
    else:
        receipt["detail"] = "ACCESS_WRITE_TOKEN_LEGACY_FORMAT_UNPROVEN"
        receipt["format_kind_hint"] = "LEGACY_UNPROVEN"
        return receipt

    receipt["format_kind_hint"] = expected_kind
    receipt["network_requests"] = 1
    try:
        payload = read(verify_url, write_token)
        if not (
            isinstance(payload, dict)
            and payload.get("success") is True
            and isinstance(payload.get("result"), dict)
        ):
            raise ValueError("VERIFY_CONTRACT_UNPROVEN")
        result = payload["result"]
        token_id = result.get("id")
        if not (isinstance(token_id, str) and TOKEN_ID_RE.fullmatch(token_id)):
            raise ValueError("VERIFY_CONTRACT_UNPROVEN")
        if result.get("status") != "active":
            raise ValueError("TOKEN_NOT_ACTIVE")
    except Exception as error:
        receipt["detail"] = "ACCESS_WRITE_TOKEN_KIND_VERIFY_FAILED"
        failure = bounded_failure(error)
        if isinstance(error, ValueError) and str(error) in {"VERIFY_CONTRACT_UNPROVEN", "TOKEN_NOT_ACTIVE"}:
            failure = str(error)
        receipt["verify_class"] = failure
        return receipt

    receipt["detail"] = "ACCESS_WRITE_TOKEN_KIND_PROOF_COMPLETE"
    receipt["token_kind"] = expected_kind
    receipt["token_status"] = "PROVEN_ACTIVE"
    return receipt


def main(env):
    try:
        receipt = classify(env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN"))
    except Exception:
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_KIND_UNCLASSIFIED")
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_KIND_PROOF_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
