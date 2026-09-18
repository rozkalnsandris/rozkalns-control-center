import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest

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


class AccountRateMessageTests(unittest.TestCase):
    def test_documented_target_account_rate_message_is_rate_limited(self):
        receipt = p.prove(TOKEN, lambda *_: account_rate_error(p.ACCOUNT), NOW)
        self.assertEqual(receipt["result"], "GRAPHQL_RATE_LIMITED")
        self.assertFalse(receipt["graphql_authorization_proven"])
        self.assertFalse(receipt["production_mutations"])

    def test_other_account_message_remains_fail_closed(self):
        receipt = p.prove(TOKEN, lambda *_: account_rate_error("other-account"), NOW)
        self.assertEqual(
            receipt["result"],
            "GRAPHQL_ERRORS_UNCLASSIFIED_PATH_NULL_EXTENSION_CODE_PRESENT_UNRECOGNIZED",
        )

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


if __name__ == "__main__":
    unittest.main()
