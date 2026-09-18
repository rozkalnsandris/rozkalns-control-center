#!/usr/bin/env python3
"""Add bounded response-envelope shape evidence to the existing token proof."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
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


def error_count_shape(errors):
    return "ERROR_COUNT_ONE" if len(errors) == 1 else "ERROR_COUNT_MULTIPLE"


def extension_keys_shape(errors):
    states = []
    for error in errors:
        extension = error.get("extensions")
        if not isinstance(extension, dict):
            states.append("OTHER")
            continue
        keys = set(extension)
        if keys == {"code", "timestamp"}:
            states.append("CODE_TIMESTAMP_ONLY")
        elif "code" in keys and "timestamp" in keys:
            states.append("CODE_TIMESTAMP_PLUS_OTHER")
        else:
            states.append("OTHER")
    if states and all(state == states[0] for state in states):
        return "EXTENSION_KEYS_" + states[0]
    return "EXTENSION_KEYS_MIXED_OR_OTHER"


def extension_other_key_count_shape(errors):
    counts = []
    for error in errors:
        extension = error.get("extensions")
        if not isinstance(extension, dict):
            return "EXTENSION_OTHER_KEY_COUNT_SHAPE_UNPROVEN"
        counts.append(len(set(extension) - {"code", "timestamp"}))
    if not counts:
        return "EXTENSION_OTHER_KEY_COUNT_SHAPE_UNPROVEN"
    if not all(count == counts[0] for count in counts):
        return "EXTENSION_OTHER_KEY_COUNT_MIXED"
    if counts[0] == 0:
        return "EXTENSION_OTHER_KEY_COUNT_ZERO"
    if counts[0] == 1:
        return "EXTENSION_OTHER_KEY_COUNT_ONE"
    return "EXTENSION_OTHER_KEY_COUNT_MULTIPLE"


def extension_other_values(errors):
    values = []
    for error in errors:
        extension = error.get("extensions")
        if not isinstance(extension, dict):
            return None
        values.extend(
            value for key, value in extension.items()
            if key not in {"code", "timestamp"}
        )
    return values


def extension_other_value_type_shape(errors):
    values = extension_other_values(errors)
    if values is None:
        return "EXTENSION_OTHER_VALUE_SHAPE_UNPROVEN"
    if not values:
        return "EXTENSION_OTHER_VALUE_NONE"

    def kind(value):
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "BOOLEAN"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return "NUMBER"
        if isinstance(value, str):
            return "STRING"
        if isinstance(value, dict):
            return "OBJECT"
        if isinstance(value, list):
            return "ARRAY"
        return "OTHER"

    kinds = [kind(value) for value in values]
    if all(value_kind == kinds[0] for value_kind in kinds):
        return "EXTENSION_OTHER_VALUE_" + kinds[0]
    return "EXTENSION_OTHER_VALUE_MIXED"


def extension_other_string_hint(errors):
    values = extension_other_values(errors)
    if values is None or len(values) != 1 or not isinstance(values[0], str):
        return "EXTENSION_OTHER_STRING_HINT_UNPROVEN"
    if not 0 < len(values[0]) <= 2_000:
        return "EXTENSION_OTHER_STRING_HINT_UNPROVEN"
    hint = p.unclassified_message_hint([values[0].casefold()])
    if hint is None:
        return "EXTENSION_OTHER_STRING_NO_UNIQUE_HINT"
    return "EXTENSION_OTHER_STRING_" + hint


def extension_other_string_shape(errors):
    values = extension_other_values(errors)
    if values is None or len(values) != 1 or not isinstance(values[0], str):
        return "EXTENSION_OTHER_STRING_SHAPE_UNPROVEN"
    value = values[0]
    if not 0 < len(value) <= 2_000:
        return "EXTENSION_OTHER_STRING_SHAPE_UNPROVEN"
    if re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
            value):
        return "EXTENSION_OTHER_STRING_TIMESTAMP_LIKE"
    if re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
            r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}",
            value):
        return "EXTENSION_OTHER_STRING_UUID_LIKE"
    if re.fullmatch(r"[0-9a-fA-F]{16,64}", value):
        return "EXTENSION_OTHER_STRING_HEX_ID_LIKE"
    if value.startswith(("https://", "http://")):
        return "EXTENSION_OTHER_STRING_URL_LIKE"
    if len(value) <= 128 and not any(character.isspace() for character in value):
        return "EXTENSION_OTHER_STRING_TOKEN_LIKE"
    if len(value) <= 128:
        return "EXTENSION_OTHER_STRING_SHORT_TEXT"
    return "EXTENSION_OTHER_STRING_LONG_TEXT"


def error_message_hint(errors):
    messages = p.error_messages(errors)
    if messages is None:
        return "ERROR_MESSAGE_SHAPE_UNPROVEN"
    hint = p.unclassified_message_hint(messages)
    if hint is None:
        return "ERROR_MESSAGE_NO_UNIQUE_HINT"
    return "ERROR_MESSAGE_" + hint


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
    bounded["error_count_shape"] = error_count_shape(errors)
    bounded["extension_keys_shape"] = extension_keys_shape(errors)
    bounded["extension_other_key_count_shape"] = extension_other_key_count_shape(errors)
    bounded["extension_other_value_type_shape"] = extension_other_value_type_shape(errors)
    bounded["extension_other_string_hint"] = extension_other_string_hint(errors)
    bounded["extension_other_string_shape"] = extension_other_string_shape(errors)
    bounded["error_message_hint"] = error_message_hint(errors)
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
