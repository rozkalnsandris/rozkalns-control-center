#!/usr/bin/env python3
"""Compose canonical read-only inventory without crossing the human-only UI boundary."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load_module("owner_panel_preflight", ROOT / "scripts/owner-panel-readonly-preflight.py")
B = load_module("owner_panel_browser_runtime", ROOT / "scripts/owner-panel-browser-compatible-runtime.py")
UI_RESULT = "NOT_PROVEN_HUMAN_ONLY_ACCESS"


def browser_health_request(url, token, **kwargs):
    original_open = urllib.request.OpenerDirector.open
    urllib.request.OpenerDirector.open = B.browser_compatible_open
    try:
        return P.request(url, token, **kwargs)
    finally:
        urllib.request.OpenerDirector.open = original_open


def composed_inventory(env, read=P.request, health_read=None, diagnostic=None, now=None):
    diagnostic = {} if diagnostic is None else diagnostic
    diagnostic["stage"] = "ENVIRONMENT"
    for name in ("CONTROL_ACCESS_CLIENT_ID", "CONTROL_ACCESS_CLIENT_SECRET"):
        P.require(bool(env.get(name)), "REQUIRED_READ_CREDENTIAL_ABSENT")

    # The service token is valid for the machine health path, not for proving
    # the human-only UI. Run the canonical inventory without Access credentials
    # so it cannot make a service-token request to the UI shell.
    base_env = dict(env)
    base_env.pop("CONTROL_ACCESS_CLIENT_ID", None)
    base_env.pop("CONTROL_ACCESS_CLIENT_SECRET", None)
    receipt = P.run(base_env, ROOT, read, diagnostic)

    access = (env["CONTROL_ACCESS_CLIENT_ID"], env["CONTROL_ACCESS_CLIENT_SECRET"])
    health_read = health_read or browser_health_request
    diagnostic["stage"] = "WORKER_HEALTH"
    request_time = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        observed = health_read(P.ORIGIN + "/api/health", None, access=access)
    except urllib.error.HTTPError as error:
        if error.code == 403:
            diagnostic["health_403"] = P.health_403_diagnostic(
                error, env, read, request_time)
        raise
    P.require(
        observed.get("status") == "ok"
        and observed.get("service") == P.WORKER
        and observed.get("workerVersion") == receipt["version"],
        "HEALTH_IDENTITY_INVALID",
    )

    # Revalidate canonical state after the protected health GET. UI evidence is
    # deliberately left unproven until a separately verified human-only path exists.
    diagnostic["stage"] = "FINAL_MAIN"
    P.require(
        read(P.GH + "/branches/main", env["GITHUB_TOKEN"])["commit"]["sha"]
        == receipt["source_sha"],
        "FINAL_MAIN_DRIFT",
    )
    diagnostic["stage"] = "FINAL_DEPLOYMENT"
    deployment_payload = read(
        P.CF + "/workers/scripts/" + P.WORKER + "/deployments",
        env["CLOUDFLARE_WORKERS_READ_TOKEN"],
    )
    P.require(
        deployment_payload.get("success") is True
        and P.baseline(deployment_payload["result"])
        == (receipt["deployment"], receipt["version"]),
        "FINAL_DEPLOYMENT_DRIFT",
    )

    receipt["health"] = "MATCH"
    receipt["ui"] = UI_RESULT
    receipt["observed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt["activation_ready"] = False
    receipt["production_mutations"] = 0
    receipt["next_gate"] = "HUMAN_UI_ACCESS_REMAINS_SEPARATE"
    return receipt


def main(env):
    diagnostic = {}
    try:
        receipt = composed_inventory(env, diagnostic=diagnostic)
    except Exception as error:
        print(json.dumps(P.failure_receipt(error, diagnostic), sort_keys=True))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(os.environ))
