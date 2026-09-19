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

LIST_RESPONSE_CLASSES = {
    "LIST_PAYLOAD_NOT_OBJECT",
    "LIST_SUCCESS_NOT_TRUE",
    "LIST_RESULT_NOT_LIST",
    "LIST_PAGE_TOO_LARGE",
    "LIST_TOTAL_TOO_LARGE",
    "LIST_PAGINATION_EXHAUSTED",
    "LIST_ROW_NOT_OBJECT",
    "TARGET_NOT_FOUND",
    "TARGET_NOT_UNIQUE",
    "TARGET_ID_INVALID",
    "TARGET_ENABLED_INVALID",
    "TARGET_DISABLED",
}


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
        require(isinstance(payload, dict), "LIST_PAYLOAD_NOT_OBJECT")
        require(payload.get("success") is True, "LIST_SUCCESS_NOT_TRUE")
        require(isinstance(payload.get("result"), list), "LIST_RESULT_NOT_LIST")
        rows = payload["result"]
        require(len(rows) <= 100, "LIST_PAGE_TOO_LARGE")
        require(all(isinstance(row, dict) for row in rows), "LIST_ROW_NOT_OBJECT")
        tokens.extend(rows)
        require(len(tokens) <= 1_000, "LIST_TOTAL_TOO_LARGE")
        if len(rows) < 100:
            return tokens
    raise ProofError("LIST_PAGINATION_EXHAUSTED")


def select_target(tokens, client_id):
    require(isinstance(client_id, str) and 1 <= len(client_id) <= 128, "CLIENT_ID_INVALID")
    require(all(isinstance(token, dict) for token in tokens), "LIST_ROW_NOT_OBJECT")
    matches = [token for token in tokens if token.get("client_id") == client_id]
    require(len(matches) > 0, "TARGET_NOT_FOUND")
    require(len(matches) == 1, "TARGET_NOT_UNIQUE")
    selected = matches[0]
    require(uuid(selected.get("id")), "TARGET_ID_INVALID")
    enabled = selected.get("enabled")
    require(enabled is None or type(enabled) is bool, "TARGET_ENABLED_INVALID")
    require(enabled is not False, "TARGET_DISABLED")
    return selected


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
        "request_stage": "NOT_STARTED",
        "response_class": "NOT_RUN",
        "selected_service_token_match": "NOT_PROVEN",
        "service_token_get_access": "NOT_PROVEN",
        "visibility_relation": "NOT_CHECKED",
        "write_token_status": "NOT_PROVEN",
    }


def classify_failure(receipt, stage, error):
    receipt["request_stage"] = stage
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 401:
            receipt["response_class"] = "HTTP_401"
            receipt["detail"] = "ACCESS_WRITE_TOKEN_AUTHENTICATION_FAILED"
        elif error.code == 403:
            receipt["response_class"] = "HTTP_403"
            receipt["detail"] = "ACCESS_WRITE_TOKEN_SERVICE_TOKEN_ACCESS_NOT_GRANTED"
        else:
            receipt["response_class"] = "HTTP_OTHER"
            receipt["detail"] = "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN"
        return receipt
    if isinstance(error, ProofError):
        code = str(error)
        receipt["response_class"] = (
            code if stage == "LIST" and code in LIST_RESPONSE_CLASSES else "CONTRACT_UNPROVEN"
        )
        receipt["detail"] = "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN"
        return receipt
    if isinstance(error, (json.JSONDecodeError, UnicodeDecodeError)):
        receipt["response_class"] = "RESPONSE_NOT_JSON"
        receipt["detail"] = "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN"
        return receipt
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        receipt["response_class"] = "REQUEST_FAILED"
        receipt["detail"] = "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN"
        return receipt
    receipt["response_class"] = "UNCLASSIFIED_FAILURE"
    receipt["detail"] = "ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN"
    return receipt


def compare_read_visibility(read_token, client_id, read=read_json):
    if not isinstance(read_token, str) or not read_token:
        return "READ_CREDENTIAL_UNAVAILABLE"
    try:
        tokens = list_service_tokens(read_token, read)
        matches = [row for row in tokens if row.get("client_id") == client_id]
    except (
        urllib.error.HTTPError,
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
        return "READ_VISIBILITY_UNPROVEN"
    if len(matches) == 1:
        return "WRITE_TARGET_HIDDEN_WHILE_READ_TARGET_VISIBLE"
    if len(matches) == 0:
        return "TARGET_NOT_VISIBLE_TO_EITHER_TOKEN"
    return "READ_VISIBILITY_UNPROVEN"


def probe(token, client_id, read=read_json, read_token=None):
    if not isinstance(token, str) or not token or not isinstance(client_id, str) or not client_id:
        return empty_receipt("ACCESS_WRITE_TOKEN_CREDENTIAL_UNAVAILABLE")

    receipt = empty_receipt("ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")

    try:
        verify_token(token, read)
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ProofError,
        ValueError,
        TypeError,
        KeyError,
    ) as error:
        return classify_failure(receipt, "VERIFY", error)

    receipt["write_token_status"] = "PROVEN_ACTIVE"
    receipt["request_stage"] = "VERIFY"
    receipt["response_class"] = "HTTP_200_CONTRACT_VALID"

    try:
        selected = select_target(list_service_tokens(token, read), client_id)
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ProofError,
        ValueError,
        TypeError,
        KeyError,
    ) as error:
        classify_failure(receipt, "LIST", error)
        if isinstance(error, ProofError) and str(error) == "TARGET_NOT_FOUND":
            receipt["visibility_relation"] = compare_read_visibility(
                read_token, client_id, read
            )
        return receipt

    receipt["selected_service_token_match"] = (
        "PROVEN_SELECTOR_MATCH_ENABLED"
        if selected.get("enabled") is True
        else "PROVEN_SELECTOR_MATCH"
    )
    receipt["request_stage"] = "LIST"
    receipt["response_class"] = "HTTP_200_CONTRACT_VALID"

    try:
        detail = get_service_token(token, selected["id"], read)
        require(detail.get("id") == selected["id"], "SERVICE_TOKEN_TARGET_MISMATCH")
        require(detail.get("client_id") == client_id, "SERVICE_TOKEN_CLIENT_ID_MISMATCH")
        detail_enabled = detail.get("enabled")
        require(
            detail_enabled is None or type(detail_enabled) is bool,
            "SERVICE_TOKEN_ENABLED_INVALID",
        )
        require(detail_enabled is not False, "SERVICE_TOKEN_DISABLED")
        if detail_enabled is True:
            receipt["selected_service_token_match"] = "PROVEN_SELECTOR_MATCH_ENABLED"
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ProofError,
        ValueError,
        TypeError,
        KeyError,
    ) as error:
        return classify_failure(receipt, "GET", error)

    receipt.update({
        "detail": "ACCESS_WRITE_TOKEN_GET_PROOF_COMPLETE",
        "permission_interpretation": "PROVEN_SERVICE_TOKEN_READ_OR_WRITE_ACCEPTED",
        "request_stage": "GET",
        "response_class": "HTTP_200_CONTRACT_VALID",
        "service_token_get_access": "PROVEN_LIST_AND_GET",
    })
    return receipt


def main(env, read=read_json):
    try:
        receipt = probe(
            env.get("CLOUDFLARE_ACCESS_WRITE_TOKEN"),
            env.get("CONTROL_ACCESS_CLIENT_ID"),
            read,
            env.get("CLOUDFLARE_ACCESS_READ_TOKEN"),
        )
    except Exception:
        receipt = empty_receipt("ACCESS_WRITE_TOKEN_RESPONSE_UNPROVEN")
        receipt["request_stage"] = "UNCLASSIFIED"
        receipt["response_class"] = "UNCLASSIFIED_FAILURE"
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "ACCESS_WRITE_TOKEN_GET_PROOF_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
