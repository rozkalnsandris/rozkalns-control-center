import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "proof", ROOT / "scripts/owner-panel-token-proof.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

TOKEN = "synthetic-private-fixture"
NOW = datetime.datetime(2026, 9, 18, 17, 0, tzinfo=datetime.timezone.utc)


def account_rate_error(account, code="private-code"):
    return {
        "data": None,
        "errors": [{
            "message": (
                f"Account {account} has exceeded its rate limit. "
                "Please try again after 5 minutes."
            ),
            "path": None,
            "extensions": {"code": code, "timestamp": "private"},
        }],
    }


def path_null_code_error(code, message="private provider detail", locations="absent"):
    error = {
        "message": message,
        "path": None,
        "extensions": {"code": code, "timestamp": "private"},
    }
    if locations != "absent":
        error["locations"] = locations
    return {"data": None, "errors": [error]}


class AccountRateMessageTests(unittest.TestCase):
    def test_documented_target_account_rate_message_is_rate_limited(self):
        receipt = p.prove(TOKEN, lambda *_: account_rate_error(p.ACCOUNT), NOW)
        self.assertEqual(receipt["result"], "GRAPHQL_RATE_LIMITED")
        self.assertFalse(receipt["graphql_authorization_proven"])
        self.assertFalse(receipt["production_mutations"])

    def test_cloudflare_authz_extension_code_is_not_granted(self):
        receipt = p.prove(TOKEN, lambda *_: path_null_code_error("authz"), NOW)
        self.assertEqual(receipt["result"], "ANALYTICS_NOT_GRANTED_FOR_TARGET")
        self.assertFalse(receipt["graphql_authorization_proven"])
        self.assertFalse(receipt["production_mutations"])

    def test_other_account_rate_message_remains_fail_closed_with_rate_hint(self):
        receipt = p.prove(TOKEN, lambda *_: account_rate_error("other-account"), NOW)
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_MESSAGE_RATE_HINT",
        )
        self.assertFalse(receipt["graphql_authorization_proven"])
        self.assertFalse(receipt["production_mutations"])

    def test_unknown_extension_code_remains_fail_closed(self):
        receipt = p.prove(TOKEN, lambda *_: path_null_code_error("private-code"), NOW)
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED",
        )

    def test_unknown_code_adds_only_one_bounded_message_hint(self):
        cases = (
            ("permission denied for this resource", "AUTH_HINT"),
            ("request throttled by a rate limit", "RATE_HINT"),
            ("query argument validation rejected", "QUERY_HINT"),
            ("upstream temporarily unavailable", "SERVICE_HINT"),
        )
        prefix = "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_MESSAGE_"
        for message, hint in cases:
            with self.subTest(hint=hint):
                receipt = p.prove(
                    TOKEN,
                    lambda *_, value=message: path_null_code_error("private-code", value),
                    NOW,
                )
                self.assertEqual(receipt["result"], prefix + hint)
                self.assertFalse(receipt["graphql_authorization_proven"])
                self.assertFalse(receipt["production_mutations"])

    def test_unknown_code_adds_only_one_bounded_code_hint(self):
        cases = (
            ("permission_denied", "AUTH_HINT"),
            ("rate_limit", "RATE_HINT"),
            ("service_unavailable", "SERVICE_HINT"),
        )
        prefix = "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_"
        for code, hint in cases:
            with self.subTest(hint=hint):
                receipt = p.prove(TOKEN, lambda *_, value=code: path_null_code_error(value), NOW)
                self.assertEqual(receipt["result"], prefix + hint)
                self.assertFalse(receipt["graphql_authorization_proven"])
                self.assertFalse(receipt["production_mutations"])

    def test_query_code_hint_adds_only_one_bounded_detail(self):
        cases = (
            ("query_error", "QUERY"),
            ("field_error", "FIELD"),
            ("argument_error", "ARGUMENT"),
            ("selection_error", "SELECTION"),
            ("parse_error", "PARSE"),
            ("validation_error", "VALIDATION"),
        )
        prefix = "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_QUERY_"
        for code, detail in cases:
            with self.subTest(detail=detail):
                receipt = p.prove(TOKEN, lambda *_, value=code: path_null_code_error(value), NOW)
                self.assertEqual(receipt["result"], prefix + detail + "_HINT")
                self.assertFalse(receipt["graphql_authorization_proven"])
                self.assertFalse(receipt["production_mutations"])

    def test_syntax_code_hint_adds_only_bounded_locations_shape(self):
        cases = (
            ("absent", "LOCATIONS_ABSENT"),
            (None, "LOCATIONS_NULL"),
            ([{"line": 3, "column": 7}], "LOCATIONS_PRESENT_VALID"),
            ([{"line": "private", "column": 7}], "LOCATIONS_MIXED_OR_INVALID"),
        )
        prefix = (
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_"
            "CODE_QUERY_SYNTAX_HINT_"
        )
        for locations, shape in cases:
            with self.subTest(shape=shape):
                receipt = p.prove(
                    TOKEN,
                    lambda *_, value=locations: path_null_code_error("syntax_error", locations=value),
                    NOW,
                )
                self.assertEqual(receipt["result"], prefix + shape)
                self.assertFalse(receipt["graphql_authorization_proven"])
                self.assertFalse(receipt["production_mutations"])

    def test_ambiguous_query_code_detail_falls_back_to_query_hint(self):
        receipt = p.prove(TOKEN, lambda *_: path_null_code_error("query_validation"), NOW)
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_QUERY_HINT",
        )
        self.assertFalse(receipt["graphql_authorization_proven"])
        self.assertFalse(receipt["production_mutations"])

    def test_ambiguous_code_hint_remains_fail_closed_without_hint(self):
        receipt = p.prove(TOKEN, lambda *_: path_null_code_error("auth_query_validation"), NOW)
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED",
        )

    def test_ambiguous_message_hint_remains_fail_closed_without_hint(self):
        receipt = p.prove(
            TOKEN,
            lambda *_: path_null_code_error(
                "private-code", "authorization query permission denied"),
            NOW,
        )
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED",
        )

    def test_transport_requests_account_based_rate_mode(self):
        with patch.object(p.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = json.dumps({"errors": None}).encode()
            p.post(TOKEN, NOW)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header("X-rate-limit-type"), "account-based")
            opener.return_value.open.assert_called_once()

    def test_public_receipt_does_not_leak_provider_detail(self):
        output = io.StringIO()
        private_code = "private-code-" + TOKEN
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                p.main(
                    {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                    lambda *_: account_rate_error(p.ACCOUNT, private_code),
                ),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["result"], "GRAPHQL_RATE_LIMITED")
        for private in (TOKEN, private_code, p.ACCOUNT, "has exceeded its rate limit"):
            self.assertNotIn(private, output.getvalue())

    def test_message_hint_receipt_does_not_leak_provider_detail(self):
        output = io.StringIO()
        private_code = "private-code-" + TOKEN
        private_message = "permission denied " + TOKEN
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                p.main(
                    {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                    lambda *_: path_null_code_error(private_code, private_message),
                ),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_MESSAGE_AUTH_HINT",
        )
        for private in (TOKEN, private_code, private_message):
            self.assertNotIn(private, output.getvalue())

    def test_code_hint_receipt_does_not_leak_provider_detail(self):
        output = io.StringIO()
        private_code = "permission_denied_" + TOKEN
        private_message = "private provider detail " + TOKEN
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                p.main(
                    {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                    lambda *_: path_null_code_error(private_code, private_message),
                ),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_AUTH_HINT",
        )
        for private in (TOKEN, private_code, private_message):
            self.assertNotIn(private, output.getvalue())

    def test_query_code_detail_receipt_does_not_leak_provider_detail(self):
        output = io.StringIO()
        private_code = "validation_" + TOKEN
        private_message = "private provider detail " + TOKEN
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                p.main(
                    {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                    lambda *_: path_null_code_error(private_code, private_message),
                ),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_QUERY_VALIDATION_HINT",
        )
        for private in (TOKEN, private_code, private_message):
            self.assertNotIn(private, output.getvalue())

    def test_syntax_locations_receipt_does_not_leak_line_or_column(self):
        output = io.StringIO()
        private_message = "private provider detail " + TOKEN
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                p.main(
                    {"CLOUDFLARE_ACCESS_READ_TOKEN": TOKEN},
                    lambda *_: path_null_code_error(
                        "syntax_error", private_message, [{"line": 321, "column": 654}]),
                ),
                1,
            )
        receipt = json.loads(output.getvalue())
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED_CODE_QUERY_SYNTAX_HINT_LOCATIONS_PRESENT_VALID",
        )
        for private in (TOKEN, private_message, "321", "654"):
            self.assertNotIn(private, output.getvalue())


if __name__ == "__main__":
    unittest.main()
