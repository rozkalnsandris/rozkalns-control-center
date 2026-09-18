import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "envelope", ROOT / "scripts/owner-panel-token-proof-envelope.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)

TOKEN = "synthetic-private-fixture"
NOW = datetime.datetime(2026, 9, 18, 21, 0, tzinfo=datetime.timezone.utc)


def syntax_error_payload(data_marker=None, *, include_data=True,
                         top_timestamp=False, extension_timestamp=False,
                         second_timestamp_mode=None):
    def error(mode=None):
        item = {
            "message": "private provider detail",
            "path": None,
            "extensions": {"code": "syntax_error"},
        }
        if mode == "top" or (mode is None and top_timestamp):
            item["timestamp"] = "private-top-timestamp"
        if mode == "extension" or (mode is None and extension_timestamp):
            item["extensions"]["timestamp"] = "private-extension-timestamp"
        if mode == "both":
            item["timestamp"] = "private-top-timestamp"
            item["extensions"]["timestamp"] = "private-extension-timestamp"
        return item

    errors = [error()]
    if second_timestamp_mode is not None:
        errors.append(error(second_timestamp_mode))
    payload = {"errors": errors}
    if include_data:
        payload["data"] = data_marker
    return payload


class EnvelopeProofTests(unittest.TestCase):
    def test_current_syntax_locations_absent_adds_bounded_shape_fields(self):
        cases = (
            (syntax_error_payload(None, extension_timestamp=True),
             "DATA_NULL", "TIMESTAMP_EXTENSION_ONLY"),
            (syntax_error_payload(None, top_timestamp=True),
             "DATA_NULL", "TIMESTAMP_TOP_LEVEL_ONLY"),
            (syntax_error_payload(None, top_timestamp=True, extension_timestamp=True),
             "DATA_NULL", "TIMESTAMP_BOTH"),
            (syntax_error_payload(None),
             "DATA_NULL", "TIMESTAMP_ABSENT"),
            (syntax_error_payload(None, top_timestamp=True,
                                  second_timestamp_mode="extension"),
             "DATA_NULL", "TIMESTAMP_MIXED"),
        )
        for payload, data_shape, timestamp_shape in cases:
            with self.subTest(timestamp_shape=timestamp_shape):
                receipt = e.prove(TOKEN, lambda *_: payload, NOW)
                self.assertEqual(receipt["result"], e.SYNTAX_LOCATIONS_ABSENT)
                self.assertEqual(receipt["response_data_shape"], data_shape)
                self.assertEqual(receipt["error_timestamp_shape"], timestamp_shape)
                self.assertFalse(receipt["graphql_authorization_proven"])
                self.assertFalse(receipt["production_mutations"])

    def test_data_shape_is_bounded(self):
        cases = (
            (syntax_error_payload(include_data=False), "DATA_KEY_ABSENT"),
            (syntax_error_payload(None), "DATA_NULL"),
            (syntax_error_payload({"private": TOKEN}), "DATA_PRESENT_NON_NULL"),
        )
        for payload, expected in cases:
            with self.subTest(expected=expected):
                receipt = e.prove(TOKEN, lambda *_: payload, NOW)
                self.assertEqual(receipt["response_data_shape"], expected)

    def test_other_results_keep_existing_receipt_shape(self):
        payload = {
            "data": None,
            "errors": [{
                "message": "private provider detail",
                "path": None,
                "extensions": {"code": "authz", "timestamp": "private"},
            }],
        }
        receipt = e.prove(TOKEN, lambda *_: payload, NOW)
        self.assertEqual(receipt["result"], "ANALYTICS_NOT_GRANTED_FOR_TARGET")
        self.assertNotIn("response_data_shape", receipt)
        self.assertNotIn("error_timestamp_shape", receipt)

    def test_public_receipt_does_not_leak_timestamp_or_data_values(self):
        private_data = "private-data-" + TOKEN
        private_timestamp = "private-timestamp-" + TOKEN
        payload = syntax_error_payload({"value": private_data})
        payload["errors"][0]["extensions"]["timestamp"] = private_timestamp
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                e.main({"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN}, lambda *_: payload),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["result"], e.SYNTAX_LOCATIONS_ABSENT)
        self.assertEqual(receipt["response_data_shape"], "DATA_PRESENT_NON_NULL")
        self.assertEqual(receipt["error_timestamp_shape"], "TIMESTAMP_EXTENSION_ONLY")
        for private in (TOKEN, private_data, private_timestamp, "private provider detail"):
            self.assertNotIn(private, output.getvalue())

    def test_wrapper_still_makes_only_one_read(self):
        calls = []
        payload = syntax_error_payload(None, extension_timestamp=True)

        def read(token, now):
            calls.append((token, now))
            return payload

        receipt = e.prove(TOKEN, read, NOW)
        self.assertEqual(receipt["result"], e.SYNTAX_LOCATIONS_ABSENT)
        self.assertEqual(calls, [(TOKEN, NOW)])


if __name__ == "__main__":
    unittest.main()
