#!/usr/bin/env python3
"""Bounded credential self-verification; no health, GraphQL, or mutation path."""
import json
import os
import re
import sys
import urllib.error
import urllib.request

ACCOUNT = "70e29dbca0e8363358659102d2b74178"
API = "https://api.cloudflare.com/client/v4"
ID = re.compile(r"[0-9a-f]{32}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(path, token):
    allowed = re.fullmatch(
        r"(?:/user/tokens/|/accounts/" + ACCOUNT + r"/tokens/)(?:verify|[0-9a-f]{32})", path)
    if not allowed:
        raise ValueError()
    req = urllib.request.Request(API + path, method="GET", headers={
        "Authorization": "Bearer " + token, "Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        if response.status != 200:
            raise ValueError()
        raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError()
        return json.loads(raw)


def result(payload):
    if (not isinstance(payload, dict) or payload.get("success") is not True
            or payload.get("errors") != [] or not isinstance(payload.get("result"), dict)):
        raise ValueError()
    return payload["result"]


def analytics_scope(details):
    policies = details.get("policies")
    if not isinstance(policies, list) or len(policies) > 100:
        return "POLICY_UNPROVEN"
    granted = False
    for policy in policies:
        if not isinstance(policy, dict) or policy.get("effect") != "allow":
            return "POLICY_UNPROVEN"
        groups, resources = policy.get("permission_groups"), policy.get("resources")
        if not isinstance(groups, list) or not groups or not isinstance(resources, dict) or not resources:
            return "POLICY_UNPROVEN"
        # Names are documented permission semantics, never publish IDs or names from responses.
        if any(not isinstance(g, dict) or not isinstance(g.get("name"), str) for g in groups):
            return "POLICY_UNPROVEN"
        if not any(g["name"] == "Account Analytics Read" for g in groups):
            continue
        for resource, scope in resources.items():
            if (not isinstance(resource, str) or scope != "*"
                    or not re.fullmatch(r"com\.cloudflare\.api\.account\.(?:\*|[0-9a-f]{32})", resource)):
                return "POLICY_UNPROVEN"
            if resource in ("com.cloudflare.api.account.*", "com.cloudflare.api.account." + ACCOUNT):
                granted = True
    return "ANALYTICS_GRANTED_FOR_TARGET" if granted else "ANALYTICS_NOT_GRANTED_FOR_TARGET"


def prove(token, read=get):
    receipt = {"identity_proven": False, "result": "TOKEN_TYPE_UNPROVEN",
               "production_mutations": False}
    if not isinstance(token, str) or not token:
        receipt["result"] = "CREDENTIAL_UNAVAILABLE"
        return receipt
    # Legacy user/account tokens are indistinguishable. Never guess or try both.
    if token.startswith("cfut_"):
        namespace, denied = "/user/tokens/", "USER_TOKEN_METADATA_READ_DENIED"
    elif token.startswith("cfat_"):
        namespace, denied = "/accounts/" + ACCOUNT + "/tokens/", "ACCOUNT_TOKEN_METADATA_READ_DENIED"
    else:
        return receipt
    try:
        verified = result(read(namespace + "verify", token))
        token_id = verified.get("id")
        if (verified.get("status") != "active" or not isinstance(token_id, str)
                or not ID.fullmatch(token_id)):
            receipt["result"] = "IDENTITY_OR_ACTIVE_STATUS_UNPROVEN"
            return receipt
        receipt["identity_proven"] = True
    except Exception:
        receipt["result"] = "SELF_VERIFY_FAILED"
        return receipt
    try:
        # Same bearer only: the server enforces its existing metadata-read authority.
        details = result(read(namespace + token_id, token))
        if details.get("id") != token_id or details.get("status") != "active":
            receipt["result"] = "DETAILS_IDENTITY_OR_STATUS_MISMATCH"
            return receipt
        receipt["result"] = analytics_scope(details)
    except urllib.error.HTTPError as error:
        receipt["result"] = denied if error.code == 403 else "TOKEN_METADATA_READ_UNPROVEN"
    except Exception:
        receipt["result"] = "TOKEN_METADATA_READ_UNPROVEN"
    return receipt


def main(env, read=get):
    try:
        receipt = prove(env.get("CLOUDFLARE_ACCESS_READ_TOKEN"), read)
    except Exception:
        receipt = {"identity_proven": False, "result": "PROOF_FAILED", "production_mutations": False}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["result"] == "ANALYTICS_GRANTED_FOR_TARGET" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
