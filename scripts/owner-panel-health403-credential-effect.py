#!/usr/bin/env python3
"""Compare Access edge health outcomes with and without service-token headers. GET-only."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "owner_panel_preflight", ROOT / "scripts/owner-panel-readonly-preflight.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)

EDGE_EFFECT_RESULTS = frozenset((
    "NO_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS",
    "PROVEN_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS",
    "PROVEN_NO_CREDENTIALS_REDIRECT",
    "PROVEN_NO_CREDENTIALS_HTTP_401",
    "PROVEN_NO_CREDENTIALS_HTTP_OTHER",
    "PROVEN_NO_CREDENTIALS_REACHED_HEALTH",
    "NOT_PROVEN_NO_CREDENTIALS_REQUEST_FAILED",
))


def response_outcome(read, access):
    try:
        read(P.ORIGIN + "/api/health", None, access=access, html=True)
        return "SUCCESS", None
    except urllib.error.HTTPError as error:
        if error.code == 403:
            response_class = P.health_403_response_class(error)
            if response_class not in P.HEALTH_ACCESS_RESPONSE_CLASSES:
                return "INVALID", None
            return "HTTP_403", response_class
        if 300 <= error.code <= 399:
            return "REDIRECT", None
        if error.code == 401:
            return "HTTP_401", None
        return "HTTP_OTHER", None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError,
            json.JSONDecodeError, UnicodeDecodeError, TypeError, AttributeError):
        return "REQUEST_FAILED", None


def credential_effect(env, read=P.request):
    if (env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF_NAME") != "main"
            or re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")) is None):
        return {"detail": "STOP", "reason": "MAIN_DISPATCH_REQUIRED",
                "production_mutations": 0}
    if not env.get("CONTROL_ACCESS_CLIENT_ID") or not env.get("CONTROL_ACCESS_CLIENT_SECRET"):
        return {"detail": "STOP", "reason": "REQUIRED_READ_CREDENTIAL_ABSENT",
                "production_mutations": 0}

    access = (env["CONTROL_ACCESS_CLIENT_ID"], env["CONTROL_ACCESS_CLIENT_SECRET"])
    authenticated_outcome, authenticated_class = response_outcome(read, access)
    if authenticated_outcome != "HTTP_403":
        return {"detail": "STOP", "reason": "AUTHENTICATED_HEALTH_NOT_403",
                "production_mutations": 0}

    unauthenticated_outcome, unauthenticated_class = response_outcome(read, None)
    if unauthenticated_outcome == "HTTP_403":
        relation = (
            "NO_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS"
            if unauthenticated_class == authenticated_class
            else "PROVEN_DISTINGUISHABLE_403_CLASS_FROM_NO_CREDENTIALS"
        )
    elif unauthenticated_outcome == "REDIRECT":
        relation = "PROVEN_NO_CREDENTIALS_REDIRECT"
    elif unauthenticated_outcome == "HTTP_401":
        relation = "PROVEN_NO_CREDENTIALS_HTTP_401"
    elif unauthenticated_outcome == "HTTP_OTHER":
        relation = "PROVEN_NO_CREDENTIALS_HTTP_OTHER"
    elif unauthenticated_outcome == "SUCCESS":
        relation = "PROVEN_NO_CREDENTIALS_REACHED_HEALTH"
    else:
        relation = "NOT_PROVEN_NO_CREDENTIALS_REQUEST_FAILED"

    if relation not in EDGE_EFFECT_RESULTS:
        return {"detail": "STOP", "reason": "EFFECT_CLASSIFICATION_INVALID",
                "production_mutations": 0}
    return {
        "detail": "BOUNDED_HEALTH403_CREDENTIAL_EFFECT_COMPLETE",
        "authenticated_health_response_class": authenticated_class,
        "access_credentials_edge_effect": relation,
        "production_mutations": 0,
    }


def main(env):
    try:
        receipt = credential_effect(env)
    except Exception:
        receipt = {"detail": "STOP", "reason": "UNEXPECTED_ERROR",
                   "production_mutations": 0}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt.get("detail") == "BOUNDED_HEALTH403_CREDENTIAL_EFFECT_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
