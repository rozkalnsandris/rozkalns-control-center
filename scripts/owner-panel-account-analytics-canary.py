#!/usr/bin/env python3
"""Bounded generic Account Analytics authorization canary; no mutation or retries."""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
SCRIPT_NAME = "rozkalns-control"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
MAX_BODY = 262_144
QUERY = " ".join("""query GetWorkersAnalytics(
  $accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        limit: 1
        filter: {
          scriptName: $scriptName
          datetime_geq: $datetimeStart
          datetime_leq: $datetimeEnd
        }
      ) {
        sum { requests }
      }
    }
  }
}""".split())

BOUNDED_RESULTS = frozenset((
    "ACCOUNT_ANALYTICS_GRANTED_FOR_TARGET",
    "TOKEN_AUTHENTICATION_FAILED",
    "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET",
    "GRAPHQL_RATE_LIMITED",
    "GRAPHQL_SERVICE_UNAVAILABLE",
    "GRAPHQL_QUERY_REJECTED",
    "GRAPHQL_RESPONSE_UNPROVEN",
    "GRAPHQL_REQUEST_UNPROVEN",
    "CREDENTIAL_UNAVAILABLE",
))


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
            "datetimeStart": iso(start),
            "datetimeEnd": iso(end),
            "scriptName": SCRIPT_NAME,
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


def extension_codes(errors):
    codes = [error.get("extensions", {}).get("code") for error in errors]
    if not all(isinstance(code, str) and 0 < len(code) <= 128 for code in codes):
        return None
    return [code.casefold() for code in codes]


def classify(payload_value):
    if not isinstance(payload_value, dict) or "errors" not in payload_value:
        return "GRAPHQL_RESPONSE_UNPROVEN"
    errors = payload_value["errors"]
    if errors is None:
        try:
            accounts = payload_value["data"]["viewer"]["accounts"]
        except (KeyError, TypeError, AttributeError):
            return "GRAPHQL_RESPONSE_UNPROVEN"
        if not isinstance(accounts, list) or len(accounts) != 1 or not isinstance(accounts[0], dict):
            return "GRAPHQL_RESPONSE_UNPROVEN"
        rows = accounts[0].get("workersInvocationsAdaptive")
        if not isinstance(rows, list) or len(rows) > 1:
            return "GRAPHQL_RESPONSE_UNPROVEN"
        return "ACCOUNT_ANALYTICS_GRANTED_FOR_TARGET"

    messages = error_messages(errors)
    if messages is None:
        return "GRAPHQL_RESPONSE_UNPROVEN"
    codes = extension_codes(errors)
    if codes is not None and all(code == "authz" for code in codes):
        return "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET"
    if all(message == "unauthorized" for message in messages):
        return "TOKEN_AUTHENTICATION_FAILED"
    if all(
        message == "not authorized for that account"
        or message.startswith("does not have access to the path")
        for message in messages
    ):
        return "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET"
    if ((codes is not None and all(code == "budget" for code in codes))
            or all("rate limit" in message or "excessive resources" in message
                   or "too many queries" in message for message in messages)):
        return "GRAPHQL_RATE_LIMITED"
    if all("internal server error" in message or "try again later" in message
           for message in messages):
        return "GRAPHQL_SERVICE_UNAVAILABLE"
    if ((codes is not None and all(any(term in code for term in (
            "query", "field", "argument", "selection", "parse", "syntax", "validation"))
            for code in codes))
            or all(any(term in message for term in (
                "query", "field", "argument", "selection", "parse", "syntax"))
                for message in messages)):
        return "GRAPHQL_QUERY_REJECTED"
    return "GRAPHQL_RESPONSE_UNPROVEN"


def prove(token, read=post, now=None):
    receipt = {
        "account_analytics_authorization_proven": False,
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
            "ACCOUNT_ANALYTICS_NOT_GRANTED_FOR_TARGET" if error.code == 403 else
            "GRAPHQL_RATE_LIMITED" if error.code == 429 else
            "GRAPHQL_SERVICE_UNAVAILABLE" if 500 <= error.code <= 599 else
            "GRAPHQL_REQUEST_UNPROVEN"
        )
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError,
            TypeError, ValueError, OSError):
        result = "GRAPHQL_REQUEST_UNPROVEN"
    if result not in BOUNDED_RESULTS:
        result = "GRAPHQL_RESPONSE_UNPROVEN"
    receipt["result"] = result
    receipt["account_analytics_authorization_proven"] = (
        result == "ACCOUNT_ANALYTICS_GRANTED_FOR_TARGET")
    return receipt


def main(env, read=post):
    try:
        receipt = prove(env.get("CLOUDFLARE_ACCESS_READ_TOKEN"), read)
    except Exception:
        receipt = {
            "account_analytics_authorization_proven": False,
            "production_mutations": False,
            "result": "GRAPHQL_REQUEST_UNPROVEN",
        }
    print(json.dumps(receipt, sort_keys=True))
    return 1 if receipt["result"] in (
        "CREDENTIAL_UNAVAILABLE", "GRAPHQL_REQUEST_UNPROVEN", "GRAPHQL_RESPONSE_UNPROVEN") else 0


if __name__ == "__main__":
    sys.exit(main(os.environ))
