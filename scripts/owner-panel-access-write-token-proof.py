#!/usr/bin/env python3
"""GET-only proof for the credential stored as CLOUDFLARE_ACCESS_WRITE_TOKEN."""
import json
import os
import re
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
VERIFY = "https://api.cloudflare.com/client/v4/user/tokens/verify"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/access/service_tokens"
MAX_BODY = 65_536
MAX_PAGES = 10


class ProofError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(ok, code):
    if not ok:
        raise ProofError(code)


def uuid(value):
    return isinstance(value, str) and re.fullmatch(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value
    ) is not None


def bearer_headers(token):
    return {
        "Accept": "application/json",
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-store",
    }


def read_json(request):
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        require(response.status == 200, "HTTP_STATUS_UNEXPECTED")
        raw = response.read(MAX_BODY + 1)
    require(len(raw) <= MAX_BODY, "RESPONSE_TOO_LARGE")
    return json.loads(raw.decode("utf-8"))


def verify_token(token, read=read_json):
    request = urllib.request.Request(
        VERIFY,
        headers=bearer_headers(token),
        method="GET",
    )
    payload = read(request)
    require(
        isinstance(payload, dict)
        and payload.get("success") is True
        and isinstance(payload.get("result"), dict)
        and payload["result"].get("status") == "active",
        "TOKEN_VERIFY_INVALID",
    )


def list_service_tokens(token, read=read_json):
    tokens = []
    for page in range(1, MAX_PAGES + 1):
        request = urllib.request.Request(
            f"{BASE}?per_page=100&page={page}",
            headers=bearer_headers(token),
            method="GET",
        )
        payload = read(request)
        require(
            isinstance(payload, dict)
            and payload.get("success") is True
            and isinstance(payload.get("result"), list),
            "SERVICE_TOKEN_LIST_INVALID",
        )
        rows = payload["result"]
        require(len(rows) <= 100, "SERVICE_TOKEN_LIST_INVALID")
        tokens.extend(rows)
        require(len(tokens) <= 1_000, "SERVICE_TOKEN_LIST_TOO_LARGE")
        if len(rows) < 100:
            return tokens
    raise ProofError("SERVICE_TOKEN_LIST_PAGINATION_EXHAUSTED")


def select_target(tokens, client_id):
    require(isinstance(client_id, str) and 1 <= len(client_id) <= 128, "CLIENT_ID_INVALID")
    require(
        all(
            isinstance(token, dict)
            and uuid(token.get("id"))
            and isinstance(token.get("client_id"), str)
            and type(token.get("enabled")) is bool
            for token in tokens
        ),
        "SERVICE_TOKEN_LIST_INVALID",
    )
    matches = [token for token in tokens if token["client_id"] == client_id]
    require(len(matches) == 1, "SELECTED_SERVICE_TOKEN_NOT_UNIQUE")
    require(matches[0]["enabled"] is True, "SELECTED_SERVICE_TOKEN_DISABLED")
    return matches[0]


def get_service_token(token, token_id, read=read_json):
    require(uuid(token_id), "SERVICE_TOKEN_ID_INVALID")
    request = urllib.request.Request(
        f"{BASE}/{token_id}",
        headers=bearer_headers(token),
        method="GET",
    )
    payload = read(request)
    require(
        isinstance(payload, dict)
        and payload.get("success") is True
        and isinstance(payload.get("result"), dict),
        "SERVICE_TOKEN_GET_INVALID",
    )
    return payload["result"]


def empty_receipt(detail):
    return {
        "detail": detail,
        "permission_interpretation": "WRITE_NOT_PROVEN_BY_GET",
        "production_mutations": 0,
        "selected_service_token_match": "NOT_PROVEN",
        "service_token_get_access": "NOT_PROVEN",
        "write_token_status": "NOT_PROVEN",
    }


def probe(token, client_id, read=read_json):
    if not isinstance(token, str) or not token or not isinstance(client_id, str) or not client_id:
        return empty_receipt("ACCESS_WRITE_TOKEN_CREDENTIAL_UNAVAILABLE")
    try:
        verify_token(token, read)
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_GET_PROOF_COMPLETE")
        receipt["write_token_status"] = "PROVEN_ACTIVE"
        selected = select_target(list_service_tokens(token, read), client_id)
        detail = get_service_token(token, selected["id"], read)
        require(detail.get("id") == selected["id"], "SERVICE_TOKEN_TARGET_MISMATCH")
        require(detail.get("client_id") == client_id, "SERVICE_TOKEN_CLIENT_ID_MISMATCH")
        require(detail.get("enabled") is True, "SERVICE_TOKEN_DISABLED")
        receipt.update({
            "permission_interpretation": "PROVEN_SERVICE_TOKEN_READ_OR_WRITE_ACCEPTED",
            "selected_service_token_match": "PROVEN_SELECTOR_MATCH_ENABLED",
            "service_token_get_access": "PROVEN_LIST_AND_GET",
        })
        return receipt
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return empty_receipt("ACCESS_WRITE_TOKEN_AUTHENTICATION_FAILED")
        if error.code == 403:
            return empty_receipt("ACCESS_WRITE_TOKEN_SERVICE_TOKEN_ACCESS_NOT_GRANTED")
        return empty_receipt("ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")
    except (
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ProofError,
        ValueError,
        TypeError,
        KeyError,
    ):
        return empty_receipt("ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")


def main(env, read=read_json):
    try:
        receipt = probe(
            env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN"),
            env.get("CONTROL_ACCESS_CLIENT_ID"),
            read,
        )
    except Exception:
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_GET_PROOF_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
