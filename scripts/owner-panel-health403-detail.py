#!/usr/bin/env python3
"""Bounded health403 detail proof. No deploy, Access mutation, secret output, or retries."""
import datetime
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

TOKEN_LIFETIME_RESULTS = frozenset((
    "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_UNEXPIRED",
    "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_EXPIRED",
    "PROVEN_SELECTED_SERVICE_TOKEN_DISABLED",
    "NOT_PROVEN_SELECTED_SERVICE_TOKEN_EXPIRY",
    "NOT_PROVEN_SELECTED_SERVICE_TOKEN_MATCH",
    "NOT_PROVEN_ACCESS_READ_FAILED",
))
GRAPHQL_RESULTS = frozenset(P.ACCESS_EVENT_DIAGNOSTICS).union((
    "PROVEN_GRAPHQL_UNAUTHORIZED",
    "PROVEN_GRAPHQL_INTERNAL_SERVER_ERROR",
))


def parse_cloudflare_time(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(datetime.timezone.utc)


def unavailable_service_token_metadata(match="NOT_PROVEN_ACCESS_READ_FAILED"):
    return {
        "service_token_lifetime": "NOT_PROVEN_SELECTED_SERVICE_TOKEN_MATCH",
        "service_token_match": match,
        "service_token_policy_eligibility": "NOT_PROVEN_SERVICE_TOKEN_MATCH",
    }


def selected_service_token_metadata(access_read_token, access_client_id, read=P.request, now=None):
    if not access_read_token:
        return unavailable_service_token_metadata("NOT_PROVEN_ACCESS_READ_CREDENTIAL_ABSENT")
    if not access_client_id:
        return unavailable_service_token_metadata("NOT_PROVEN_ACCESS_CLIENT_ID_ABSENT")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        apps = P.access_pages(read, access_read_token, P.access_apps_url)
        candidates = [(score, app["id"]) for app in apps
                      if (score := P.health_access_match_score(app)) is not None]
        if not candidates:
            return unavailable_service_token_metadata("NOT_PROVEN_SEPARATE_READ_SCOPE")
        best_score = max(score for score, _ in candidates)
        app_ids = sorted({app_id for score, app_id in candidates if score == best_score})
        P.require(1 <= len(app_ids) <= 20, "CF_RESPONSE_INVALID")
        policies = []
        for app_id in app_ids:
            policies.extend(P.access_pages(
                read, access_read_token,
                lambda page, app_id=app_id: P.access_app_policies_url(app_id, page)))
            P.require(len(policies) <= 200, "CF_RESPONSE_INVALID")
        any_valid, token_ids, invalid = P.service_token_policy_selectors(policies)
        if not any_valid and not token_ids:
            return unavailable_service_token_metadata(
                "NOT_PROVEN_SERVICE_TOKEN_SELECTOR_INVALID" if invalid
                else "NOT_PROVEN_NO_SERVICE_TOKEN_SELECTOR")
        if invalid:
            return unavailable_service_token_metadata("NOT_PROVEN_SERVICE_TOKEN_SELECTOR_INVALID")
        try:
            tokens = P.access_pages(read, access_read_token, P.access_service_tokens_url)
        except urllib.error.HTTPError as error:
            metadata = unavailable_service_token_metadata(
                "NOT_PROVEN_SERVICE_TOKENS_READ_DENIED" if error.code in (401, 403)
                else "NOT_PROVEN_SERVICE_TOKENS_READ_FAILED")
            metadata["service_token_lifetime"] = "NOT_PROVEN_ACCESS_READ_FAILED"
            return metadata
        except (P.PreflightError, urllib.error.URLError, TimeoutError,
                json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError,
                IndexError, OSError):
            metadata = unavailable_service_token_metadata("NOT_PROVEN_SERVICE_TOKENS_READ_FAILED")
            metadata["service_token_lifetime"] = "NOT_PROVEN_ACCESS_READ_FAILED"
            return metadata
        P.require(all(isinstance(token, dict) and P.uuid(token.get("id"))
                      and isinstance(token.get("client_id"), str)
                      and type(token.get("enabled")) is bool for token in tokens),
                  "CF_RESPONSE_INVALID")
        client_tokens = [token for token in tokens if token["client_id"] == access_client_id]
        if not client_tokens:
            return unavailable_service_token_metadata("NOT_PROVEN_SERVICE_TOKEN_CLIENT_ID_NOT_LISTED")
        selected = [token for token in client_tokens if any_valid or token["id"] in token_ids]
        if not selected:
            return unavailable_service_token_metadata("NOT_PROVEN_SERVICE_TOKEN_NOT_SELECTED")
        enabled_selected_ids = frozenset(token["id"] for token in selected if token["enabled"])
        service_token_match = (
            "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED" if enabled_selected_ids
            else "NOT_PROVEN_SERVICE_TOKEN_DISABLED")
        policy_eligibility = P.selected_service_token_policy_eligibility(
            policies, service_token_match, enabled_selected_ids)
        if len(selected) != 1:
            lifetime = "NOT_PROVEN_SELECTED_SERVICE_TOKEN_MATCH"
        else:
            token = selected[0]
            if not token["enabled"]:
                lifetime = "PROVEN_SELECTED_SERVICE_TOKEN_DISABLED"
            else:
                expires_at = parse_cloudflare_time(token.get("expires_at"))
                if expires_at is None:
                    lifetime = "NOT_PROVEN_SELECTED_SERVICE_TOKEN_EXPIRY"
                else:
                    lifetime = ("PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_EXPIRED"
                                if expires_at <= now.astimezone(datetime.timezone.utc)
                                else "PROVEN_SELECTED_SERVICE_TOKEN_ENABLED_UNEXPIRED")
        return {
            "service_token_lifetime": lifetime,
            "service_token_match": service_token_match,
            "service_token_policy_eligibility": policy_eligibility,
        }
    except (P.PreflightError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
            json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError,
            IndexError, OSError, ValueError):
        metadata = unavailable_service_token_metadata("NOT_PROVEN_ACCESS_READ_FAILED")
        metadata["service_token_lifetime"] = "NOT_PROVEN_ACCESS_READ_FAILED"
        return metadata


def selected_service_token_lifetime(access_read_token, access_client_id, read=P.request, now=None):
    return selected_service_token_metadata(
        access_read_token, access_client_id, read, now)["service_token_lifetime"]


def graphql_top_level_result(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("errors"), list) or not payload["errors"]:
        return P.access_event_result(payload)
    errors = payload["errors"]
    if not all(isinstance(error, dict) and isinstance(error.get("message"), str)
               and len(error["message"]) <= 2_000 for error in errors):
        return "NOT_PROVEN_GRAPHQL_RESPONSE_ERROR"
    messages = [error["message"].casefold() for error in errors]
    if all(message == "unauthorized" for message in messages):
        return "PROVEN_GRAPHQL_UNAUTHORIZED"
    if all(message == "internal server error" for message in messages):
        return "PROVEN_GRAPHQL_INTERNAL_SERVER_ERROR"
    return P.graphql_error_result(errors)


def health403_detail(env, read=P.request, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if (env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF_NAME") != "main"
            or re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")) is None):
        return {"detail": "STOP", "reason": "MAIN_DISPATCH_REQUIRED",
                "production_mutations": 0, "activation_ready": False}
    required = ("CLOUDFLARE_ACCESS_READ_TOKEN", "CONTROL_ACCESS_CLIENT_ID", "CONTROL_ACCESS_CLIENT_SECRET")
    if not all(env.get(name) for name in required):
        return {"detail": "STOP", "reason": "REQUIRED_READ_CREDENTIAL_ABSENT",
                "production_mutations": 0, "activation_ready": False}
    access = (env["CONTROL_ACCESS_CLIENT_ID"], env["CONTROL_ACCESS_CLIENT_SECRET"])
    try:
        read(P.ORIGIN + "/api/health", None, access=access)
        return {"detail": "STOP", "reason": "HEALTH_NOT_403",
                "production_mutations": 0, "activation_ready": False}
    except urllib.error.HTTPError as error:
        if error.code != 403:
            return {"detail": "STOP", "reason": "HEALTH_HTTP_OTHER",
                    "production_mutations": 0, "activation_ready": False}
        health_response_class = P.health_403_response_class(error)
        ray_id = P.private_cf_ray_id(error)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return {"detail": "STOP", "reason": "HEALTH_REQUEST_FAILED",
                "production_mutations": 0, "activation_ready": False}

    token_metadata = selected_service_token_metadata(
        env["CLOUDFLARE_ACCESS_READ_TOKEN"], env["CONTROL_ACCESS_CLIENT_ID"], read, now)
    graphql_result = "NOT_PROVEN_CF_RAY_HEADER_ABSENT_OR_INVALID"
    if ray_id is not None:
        try:
            payload = read(P.GRAPHQL, env["CLOUDFLARE_ACCESS_READ_TOKEN"],
                           graphql=P.graphql_access_login_payload(ray_id, now))
            graphql_result = graphql_top_level_result(payload)
        except urllib.error.HTTPError as error:
            graphql_result = ("PROVEN_ACCOUNT_ANALYTICS_READ_MISSING" if error.code == 403 else
                              "NOT_PROVEN_ANALYTICS_TOKEN_INVALID" if error.code == 401 else
                              "NOT_PROVEN_GRAPHQL_ACCESS_EVENT_READ_FAILED")
        except (P.PreflightError, urllib.error.URLError, TimeoutError, json.JSONDecodeError,
                UnicodeDecodeError, KeyError, TypeError, AttributeError, IndexError, OSError):
            graphql_result = "NOT_PROVEN_GRAPHQL_ACCESS_EVENT_READ_FAILED"

    if (health_response_class not in P.HEALTH_ACCESS_RESPONSE_CLASSES
            or token_metadata["service_token_lifetime"] not in TOKEN_LIFETIME_RESULTS
            or token_metadata["service_token_match"] not in P.ACCESS_POLICY_DIAGNOSTICS
            or token_metadata["service_token_policy_eligibility"] not in P.SERVICE_TOKEN_POLICY_ELIGIBILITY
            or graphql_result not in GRAPHQL_RESULTS):
        return {"detail": "STOP", "reason": "DETAIL_CLASSIFICATION_INVALID",
                "production_mutations": 0, "activation_ready": False}
    return {
        "detail": "BOUNDED_HEALTH403_DETAIL_COMPLETE",
        "health_403_response_class": health_response_class,
        "service_token_lifetime": token_metadata["service_token_lifetime"],
        "service_token_match": token_metadata["service_token_match"],
        "service_token_policy_eligibility": token_metadata["service_token_policy_eligibility"],
        "client_secret_validity": "NOT_PROVEN_BY_METADATA",
        "graphql_access_event": graphql_result,
        "production_mutations": 0,
        "activation_ready": False,
    }


def main(env):
    try:
        receipt = health403_detail(env)
    except Exception:
        receipt = {"detail": "STOP", "reason": "UNEXPECTED_ERROR",
                   "production_mutations": 0, "activation_ready": False}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt.get("detail") == "BOUNDED_HEALTH403_DETAIL_COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main(os.environ))
