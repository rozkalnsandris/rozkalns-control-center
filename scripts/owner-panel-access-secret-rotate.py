#!/usr/bin/env python3
"""One-shot Access service-token secret rotation with fail-closed handoff semantics."""
import datetime
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/access/service_tokens"
MAX_RESPONSE_BYTES = 65_536
MAX_PAGES = 10


class RotationError(ValueError):
    pass


class RotationStateUncertain(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise RotationError(code)


def uuid(value):
    return isinstance(value, str) and re.fullmatch(
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value
    ) is not None


def default_send(request):
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    require(len(raw) <= MAX_RESPONSE_BYTES, "CF_RESPONSE_TOO_LARGE")
    return json.loads(raw.decode("utf-8"))


def bearer_headers(token):
    return {
        "Accept": "application/json",
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-store",
    }


def list_service_tokens(read_token, send=default_send):
    tokens = []
    for page in range(1, MAX_PAGES + 1):
        request = urllib.request.Request(
            f"{BASE}?per_page=100&page={page}",
            headers=bearer_headers(read_token),
            method="GET",
        )
        payload = send(request)
        require(
            isinstance(payload, dict)
            and payload.get("success") is True
            and isinstance(payload.get("result"), list),
            "SERVICE_TOKEN_LIST_INVALID",
        )
        page_tokens = payload["result"]
        require(len(page_tokens) <= 100, "SERVICE_TOKEN_LIST_INVALID")
        tokens.extend(page_tokens)
        require(len(tokens) <= 1_000, "SERVICE_TOKEN_LIST_TOO_LARGE")
        if len(page_tokens) < 100:
            return tokens
    raise RotationError("SERVICE_TOKEN_LIST_PAGINATION_EXHAUSTED")


def select_target(tokens, client_id):
    require(isinstance(client_id, str) and 1 <= len(client_id) <= 256, "CLIENT_ID_INVALID")
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


def rfc3339_utc(value):
    value = value.astimezone(datetime.timezone.utc).replace(microsecond=0)
    return value.isoformat().replace("+00:00", "Z")


def write_private_payload(path, client_id, client_secret):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                {"client_id": client_id, "client_secret": client_secret},
                handle,
                separators=(",", ":"),
            )
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def rotate_selected_secret(
    read_token, write_token, client_id, output_file, send=default_send, now=None
):
    tokens = list_service_tokens(read_token, send)
    selected = select_target(tokens, client_id)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    grace_expires_at = rfc3339_utc(now + datetime.timedelta(hours=1))
    body = json.dumps(
        {"previous_client_secret_expires_at": grace_expires_at},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE}/{selected['id']}/rotate",
        data=body,
        headers={**bearer_headers(write_token), "Content-Type": "application/json"},
        method="POST",
    )

    try:
        payload = send(request)
    except Exception as exc:
        raise RotationStateUncertain("ROTATION_STATE_UNCERTAIN") from exc

    try:
        require(
            isinstance(payload, dict)
            and payload.get("success") is True
            and isinstance(payload.get("result"), dict),
            "ROTATE_RESPONSE_INVALID",
        )
        result = payload["result"]
        require(result.get("id") == selected["id"], "ROTATE_TARGET_MISMATCH")
        require(result.get("client_id") == client_id, "ROTATE_CLIENT_ID_MISMATCH")
        client_secret = result.get("client_secret")
        require(
            isinstance(client_secret, str)
            and 20 <= len(client_secret) <= 256
            and re.fullmatch(r"[^\s]+", client_secret) is not None,
            "ROTATE_SECRET_INVALID",
        )
        write_private_payload(output_file, client_id, client_secret)
    except Exception as exc:
        raise RotationStateUncertain("ROTATION_STATE_UNCERTAIN") from exc

    return {
        "detail": "SELECTED_ACCESS_SERVICE_TOKEN_SECRET_ROTATED",
        "client_id_unchanged": True,
        "previous_secret_grace": "PT1H",
        "previous_client_secret_expires_at": grace_expires_at,
        "production_mutations": 1,
    }


def run(env, send=default_send, now=None):
    if (
        env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or env.get("GITHUB_REF_NAME") != "main"
        or re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")) is None
        or env.get("EXPECTED_MAIN_SHA") != env.get("GITHUB_SHA")
    ):
        return {
            "detail": "STOP",
            "reason": "EXACT_MAIN_DISPATCH_REQUIRED",
            "production_mutations": 0,
        }

    required = (
        "CLOUDFLARE_ACCESS_READ_TOKEN",
        "CLOUDFLARE_ACCESS_WRITE_TOKEN",
        "CONTROL_ACCESS_CLIENT_ID",
        "ROTATION_OUTPUT_FILE",
        "RUNNER_TEMP",
    )
    if not all(env.get(name) for name in required):
        return {
            "detail": "STOP",
            "reason": "REQUIRED_ROTATION_INPUT_ABSENT",
            "production_mutations": 0,
        }

    runner_temp = Path(env["RUNNER_TEMP"]).resolve()
    output_file = Path(env["ROTATION_OUTPUT_FILE"]).resolve()
    if output_file.parent != runner_temp or output_file.exists():
        return {
            "detail": "STOP",
            "reason": "ROTATION_OUTPUT_PATH_INVALID",
            "production_mutations": 0,
        }

    try:
        return rotate_selected_secret(
            env["CLOUDFLARE_ACCESS_READ_TOKEN"],
            env["CLOUDFLARE_ACCESS_WRITE_TOKEN"],
            env["CONTROL_ACCESS_CLIENT_ID"],
            output_file,
            send,
            now,
        )
    except RotationStateUncertain:
        return {
            "detail": "STOP",
            "reason": "ROTATION_STATE_UNCERTAIN",
            "production_mutations": "UNKNOWN_AFTER_ROTATE_REQUEST",
        }
    except (
        RotationError,
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
        ValueError,
        TypeError,
        KeyError,
    ):
        return {
            "detail": "STOP",
            "reason": "ROTATION_PREFLIGHT_FAILED",
            "production_mutations": 0,
        }


def main(env):
    receipt = run(env)
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt.get("detail") == "SELECTED_ACCESS_SERVICE_TOKEN_SECRET_ROTATED" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
