#!/usr/bin/env python3
"""GET-only metadata probe for recovery after an uncertain Access secret rotation."""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/access/service_tokens"
MAX_BODY = 65_536
MAX_PAGES = 10
INCIDENT = datetime.datetime(2026, 9, 19, 8, 36, 31, tzinfo=datetime.timezone.utc)
INCIDENT_WINDOW = datetime.timedelta(minutes=2)
EXPECTED_GRACE_EXPIRY = INCIDENT + datetime.timedelta(hours=1)
GRACE_WINDOW = datetime.timedelta(minutes=2)


class ProbeError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(ok, code):
    if not ok:
        raise ProbeError(code)


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


def list_service_tokens(read_token, read=read_json):
    tokens = []
    for page in range(1, MAX_PAGES + 1):
        request = urllib.request.Request(
            f"{BASE}?per_page=100&page={page}",
            headers=bearer_headers(read_token),
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
    raise ProbeError("SERVICE_TOKEN_LIST_PAGINATION_EXHAUSTED")


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


def get_service_token(read_token, token_id, read=read_json):
    require(uuid(token_id), "SERVICE_TOKEN_ID_INVALID")
    request = urllib.request.Request(
        f"{BASE}/{token_id}",
        headers=bearer_headers(read_token),
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


def parse_rfc3339(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(datetime.timezone.utc)


def version_shape(value):
    if value is None:
        return "VERSION_ABSENT"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "VERSION_INVALID"
    if isinstance(value, float) and not value.is_integer():
        return "VERSION_INVALID"
    number = int(value)
    if number == 1:
        return "VERSION_ONE"
    if 2 <= number <= 1_000_000:
        return "VERSION_GE_TWO"
    return "VERSION_INVALID"


def timestamp_relation(value, target, window, prefix):
    parsed = parse_rfc3339(value)
    if value is None:
        return prefix + "_ABSENT"
    if parsed is None:
        return prefix + "_INVALID"
    if target - window <= parsed <= target + window:
        return prefix + "_MATCH"
    if parsed < target - window:
        return prefix + "_BEFORE"
    return prefix + "_AFTER"


def metadata_signature(version, updated, grace):
    version_rotated = version == "VERSION_GE_TWO"
    updated_match = updated == "UPDATED_AT_INCIDENT_WINDOW_MATCH"
    grace_match = grace == "PREVIOUS_SECRET_GRACE_MATCH"
    if version_rotated and updated_match and grace_match:
        return "VERSION_UPDATED_GRACE_MATCH"
    if version_rotated and updated_match:
        return "VERSION_UPDATED_MATCH"
    if updated_match and grace_match:
        return "UPDATED_GRACE_MATCH"
    if version_rotated or updated_match or grace_match:
        return "PARTIAL_METADATA_SIGNAL"
    if version in ("VERSION_ABSENT", "VERSION_INVALID") and updated in (
        "UPDATED_AT_INCIDENT_WINDOW_ABSENT", "UPDATED_AT_INCIDENT_WINDOW_INVALID"
    ) and grace in ("PREVIOUS_SECRET_GRACE_ABSENT", "PREVIOUS_SECRET_GRACE_INVALID"):
        return "METADATA_FIELDS_UNAVAILABLE"
    return "NO_INCIDENT_METADATA_SIGNAL"


def probe(read_token, client_id, read=read_json):
    receipt = {
        "client_secret_version_shape": "VERSION_ABSENT",
        "detail": "ROTATION_RECOVERY_READ_FAILED",
        "previous_secret_grace_relation": "PREVIOUS_SECRET_GRACE_ABSENT",
        "production_mutations": 0,
        "rotation_metadata_signature": "METADATA_FIELDS_UNAVAILABLE",
        "service_token_match": "NOT_PROVEN",
        "updated_at_relation": "UPDATED_AT_INCIDENT_WINDOW_ABSENT",
    }
    if not isinstance(read_token, str) or not read_token or not isinstance(client_id, str) or not client_id:
        receipt["detail"] = "ROTATION_RECOVERY_CREDENTIAL_UNAVAILABLE"
        return receipt
    try:
        selected = select_target(list_service_tokens(read_token, read), client_id)
        detail = get_service_token(read_token, selected["id"], read)
        require(detail.get("id") == selected["id"], "SERVICE_TOKEN_TARGET_MISMATCH")
        require(detail.get("client_id") == client_id, "SERVICE_TOKEN_CLIENT_ID_MISMATCH")
        require(detail.get("enabled") is True, "SERVICE_TOKEN_DISABLED_AFTER_INCIDENT")

        version = version_shape(detail.get("client_secret_version"))
        updated = timestamp_relation(
            detail.get("updated_at"), INCIDENT, INCIDENT_WINDOW, "UPDATED_AT_INCIDENT_WINDOW"
        )
        grace = timestamp_relation(
            detail.get("previous_client_secret_expires_at"),
            EXPECTED_GRACE_EXPIRY,
            GRACE_WINDOW,
            "PREVIOUS_SECRET_GRACE",
        )
        receipt.update({
            "client_secret_version_shape": version,
            "detail": "ROTATION_RECOVERY_METADATA_COMPLETE",
            "previous_secret_grace_relation": grace,
            "rotation_metadata_signature": metadata_signature(version, updated, grace),
            "service_token_match": "PROVEN_SELECTOR_MATCH_ENABLED",
            "updated_at_relation": updated,
        })
        return receipt
    except urllib.error.HTTPError as error:
        receipt["detail"] = (
            "ROTATION_RECOVERY_READ_DENIED" if error.code in (401, 403)
            else "ROTATION_RECOVERY_READ_FAILED"
        )
        return receipt
    except (
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ProbeError,
        ValueError,
        TypeError,
        KeyError,
    ):
        return receipt


def main(env, read=read_json):
    try:
        receipt = probe(
            env.get("CLOUDFLARE_ACCESS_READ_TOKEN"),
            env.get("CONTROL_ACCESS_CLIENT_ID"),
            read,
        )
    except Exception:
        receipt = {
            "client_secret_version_shape": "VERSION_ABSENT",
            "detail": "ROTATION_RECOVERY_READ_FAILED",
            "previous_secret_grace_relation": "PREVIOUS_SECRET_GRACE_ABSENT",
            "production_mutations": 0,
            "rotation_metadata_signature": "METADATA_FIELDS_UNAVAILABLE",
            "service_token_match": "NOT_PROVEN",
            "updated_at_relation": "UPDATED_AT_INCIDENT_WINDOW_ABSENT",
        }
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["detail"] == "ROTATION_RECOVERY_METADATA_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
