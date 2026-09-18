#!/usr/bin/env python3
"""Bounded direct GraphQL Analytics authorization proof; no mutation or retries."""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
SYNTHETIC_RAY = "0000000000000000"
MAX_BODY = 262_144
QUERY = """query accessLoginRequestsAdaptiveGroups(
  $accountTag: string, $rayId: string, $datetimeStart: string, $datetimeEnd: string
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      accessLoginRequestsAdaptiveGroups(
        limit: 1
        filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, cfRayId: $rayId}
        orderBy: [datetime_ASC]
      ) {
        dimensions { isSuccessfulLogin identityProvider serviceTokenId }
      }
    }
  }
}"""

AUTHZ_MESSAGES = (
    "not authorized for that account",
    "does not have access to the path",
)
RATE_MESSAGES = (
    "rate limiter budget depleted, try again after",
    "in combination, your request queries too many nodes, zones and accounts",
    "query consumed excessive resources",
    "too many queries in progress, please try again later",
)
ACCOUNT_RATE_MESSAGE_PREFIX = f"account {ACCOUNT} has exceeded its rate limit."
SERVICE_MESSAGES = (
    "internal server error",
    "unable to execute query, please try again later",
)
QUERY_MESSAGES = (
    "error parsing args",
    "scalar fields must have no selections",
    "object field must have selections",
    "unknown field",
    "query contains error, please review it and retry",
    "cannot request data older than",
    "number of fields can't be more than",
    "limit must be positive number and not greater than",
    "query time range is too large",
)
UNCLASSIFIED_MESSAGE_HINTS = (
    ("AUTH_HINT", ("authoriz", "permission", "forbidden", "denied", "credential", "token")),
    ("RATE_HINT", ("rate limit", "rate-limit", "throttl", "budget", "too many", "excessive")),
    ("QUERY_HINT", ("query", "field", "argument", "selection", "parse", "syntax")),
    ("SERVICE_HINT", ("internal", "unavailable", "upstream", "timeout", "temporar", "in progress")),
)
ACCESS_LOGIN_ERROR_PATHS = (
    ["viewer", "accounts", 0, "accessLoginRequestsAdaptiveGroups"],
    ["viewer", "accounts", "0", "accessLoginRequestsAdaptiveGroups"],
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def iso(value):
    return value.astimezone(datetime.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")


def payload(now):
    if not isinstance(now, datetime.datetime) or now.tzinfo is None:
        raise ValueError()
    end = now.astimezone(datetime.timezone.utc)
    start = end - datetime.timedelta(minutes=5)
    return {
        "query": QUERY,
        "variables": {
            "accountTag": ACCOUNT,
            "rayId": SYNTHETIC_RAY,
            "datetimeStart": iso(start),
            "datetimeEnd": iso(end),
        },
    }


def post(token, now):
    if not isinstance(token, str) or not token:
        raise ValueError()
    body = json.dumps(payload(now), separators=(",", ":")).encode()
    req = urllib.request.Request(
        GRAPHQL,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Rate-Limit-Type": "account-based",
        },
    )
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        if response.status != 200:
            raise ValueError()
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise ValueError()
        return json.loads(raw)


def error_messages(errors):
    if (not isinstance(errors, list) or not errors or len(errors) > 10
            or not all(isinstance(error, dict)
                       and isinstance(error.get("message"), str)
                       and 0 < len(error["message"]) <= 2_000
                       for error in errors)):
        return None
    return [error["message"].casefold() for error in errors]


def unclassified_message_hint(messages):
    matches = [
        name for name, terms in UNCLASSIFIED_MESSAGE_HINTS
        if all(any(term in message for term in terms) for message in messages)
    ]
    return matches[0] if len(matches) == 1 else None


def unclassified_path_null_extension_code_result(errors):
    if not all("path" in error and error["path"] is None for error in errors):
        return None

    def extension(error):
        return error.get("extensions")

    if all(isinstance(extension(error), dict)
           and extension(error).get("code") == "authz"
           for error in errors):
        return "ANALYTICS_NOT_GRANTED_FOR_TARGET"
    if all(isinstance(extension(error), dict)
           and extension(error).get("code") == "budget"
           for error in errors):
        return "GRAPHQL_RATE_LIMITED"
    if all(isinstance(extension(error), dict)
           and isinstance(extension(error).get("code"), str)
           and 0 < len(extension(error)["code"]) <= 128
           for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED"
    if all("extensions" not in error for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSIONS_KEY_ABSENT"
    if all(isinstance(extension(error), dict)
           and "code" not in extension(error) for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_KEY_ABSENT"
    if all(isinstance(extension(error), dict)
           and "code" in extension(error)
           and extension(error)["code"] is None for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_NULL"
    if all(isinstance(extension(error), dict)
           and "code" in extension(error)
           and extension(error)["code"] is not None
           and not isinstance(extension(error)["code"], str)
           for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_INVALID_NON_STRING"
    return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_MIXED_OR_INVALID"


def unclassified_error_path_result(errors):
    path_null_extension_result = unclassified_path_null_extension_code_result(errors)
    if path_null_extension_result is not None:
        return path_null_extension_result

    paths = [error.get("path") for error in errors]
    if all(isinstance(path, list) and path in ACCESS_LOGIN_ERROR_PATHS for path in paths):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_ACCESS_DATASET"
    if all(isinstance(path, list) for path in paths):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_PRESENT_UNRECOGNIZED"
    if all("path" not in error for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_KEY_ABSENT"
    if all("path" in error and error["path"] is not None
           and not isinstance(error["path"], list) for error in errors):
        return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_PRESENT_INVALID_NON_NULL"
    return "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_MIXED_OR_INVALID"


def classify(payload_value):
    if not isinstance(payload_value, dict):
        return "GRAPHQL_RESPONSE_NOT_OBJECT"
    if "errors" not in payload_value:
        return "GRAPHQL_ERRORS_FIELD_MISSING"

    errors = payload_value["errors"]
    if errors is None:
        try:
            data = payload_value["data"]
            viewer = data["viewer"]
            accounts = viewer["accounts"]
        except (KeyError, TypeError, AttributeError):
            return "GRAPHQL_SUCCESS_DATA_SHAPE_UNPROVEN"
        if not isinstance(accounts, list) or len(accounts) != 1:
            return "GRAPHQL_SUCCESS_TARGET_ACCOUNT_UNPROVEN"
        if not isinstance(accounts[0], dict):
            return "GRAPHQL_SUCCESS_DATA_SHAPE_UNPROVEN"
        events = accounts[0].get("accessLoginRequestsAdaptiveGroups")
        if not isinstance(events, list) or len(events) > 1:
            return "GRAPHQL_SUCCESS_DATASET_SHAPE_UNPROVEN"
        return "ANALYTICS_GRANTED_FOR_TARGET"

    messages = error_messages(errors)
    if messages is None:
        return "GRAPHQL_ERRORS_SHAPE_UNPROVEN"
    if all(message == "unauthorized" for message in messages):
        return "TOKEN_AUTHENTICATION_FAILED"
    if all(message == "not authorized for that account"
           or message.startswith("does not have access to the path")
           or (message.startswith("zones ") and message.endswith(" are not authorized"))
           for message in messages):
        return "ANALYTICS_NOT_GRANTED_FOR_TARGET"
    if all(message.startswith(ACCOUNT_RATE_MESSAGE_PREFIX)
           or any(message.startswith(prefix) for prefix in RATE_MESSAGES)
           for message in messages):
        return "GRAPHQL_RATE_LIMITED"
    if all(any(message.startswith(prefix) for prefix in SERVICE_MESSAGES)
           for message in messages):
        return "GRAPHQL_SERVICE_UNAVAILABLE"
    if all(any(message.startswith(prefix) for prefix in QUERY_MESSAGES)
           for message in messages):
        return "GRAPHQL_QUERY_REJECTED"
    result = unclassified_error_path_result(errors)
    if result == "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED":
        hint = unclassified_message_hint(messages)
        if hint is not None:
            return result + "_MESSAGE_" + hint
    return result


def prove(token, read=post, now=None):
    receipt = {
        "graphql_authorization_proven": False,
        "production_mutations": False,
        "result": "CREDENTIAL_UNAVAILABLE",
    }
    if not isinstance(token, str) or not token:
        return receipt
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        result = classify(read(token, now))
    except urllib.error.HTTPError as error:
        result = (
            "TOKEN_AUTHENTICATION_FAILED" if error.code == 401 else
            "ANALYTICS_NOT_GRANTED_FOR_TARGET" if error.code == 403 else
            "GRAPHQL_RATE_LIMITED" if error.code == 429 else
            "GRAPHQL_SERVICE_UNAVAILABLE" if 500 <= error.code <= 599 else
            "GRAPHQL_HTTP_UNPROVEN"
        )
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError,
            TypeError, ValueError, OSError):
        result = "GRAPHQL_REQUEST_UNPROVEN"
    receipt["result"] = result
    receipt["graphql_authorization_proven"] = result == "ANALYTICS_GRANTED_FOR_TARGET"
    return receipt


def main(env, read=post):
    try:
        receipt = prove(env.get("CLOUDFLARE_ACCESS_READ_TOKEN"), read)
    except Exception:
        receipt = {
            "graphql_authorization_proven": False,
            "production_mutations": False,
            "result": "PROOF_FAILED",
        }
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["result"] == "ANALYTICS_GRANTED_FOR_TARGET" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
