#!/usr/bin/env python3
"""Add bounded response-envelope shape evidence to the existing token proof."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "owner_panel_token_proof", ROOT / "scripts/owner-panel-token-proof.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

SYNTAX_LOCATIONS_ABSENT = (
    "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_"
    "CODE_QUERY_SYNTAX_HINT_LOCATIONS_ABSENT"
)


def response_data_shape(payload_value):
    if "data" not in payload_value:
        return "DATA_KEY_ABSENT"
    if payload_value["data"] is None:
        return "DATA_NULL"
    return "DATA_PRESENT_NON_NULL"


def error_timestamp_shape(errors):
    states = []
    for error in errors:
        top_level = "timestamp" in error
        extension = error.get("extensions")
        extension_level = isinstance(extension, dict) and "timestamp" in extension
        if top_level and extension_level:
            states.append("BOTH")
        elif top_level:
            states.append("TOP_LEVEL_ONLY")
        elif extension_level:
            states.append("EXTENSION_ONLY")
        else:
            states.append("ABSENT")
    if states and all(state == states[0] for state in states):
        return "TIMESTAMP_" + states[0]
    return "TIMESTAMP_MIXED"


def prove(token, read=p.post, now=None):
    captured = {}

    def capture(bearer, observed_at):
        value = read(bearer, observed_at)
        captured["payload"] = value
        return value

    receipt = p.prove(token, capture, now)
    if receipt["result"] != SYNTAX_LOCATIONS_ABSENT:
        return receipt

    payload_value = captured.get("payload")
    if not isinstance(payload_value, dict):
        return receipt
    errors = payload_value.get("errors")
    if not isinstance(errors, list) or not errors or not all(
            isinstance(error, dict) for error in errors):
        return receipt

    bounded = dict(receipt)
    bounded["response_data_shape"] = response_data_shape(payload_value)
    bounded["error_timestamp_shape"] = error_timestamp_shape(errors)
    return bounded


def main(env, read=p.post):
    try:
        receipt = prove(
            env.get("CLOUDFLARE_ACCESS_READ_TOKEN"),
            read,
            datetime.datetime.now(datetime.timezone.utc),
        )
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
