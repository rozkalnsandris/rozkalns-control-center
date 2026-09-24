import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / ".github/worker-deploy-secret-recovery.json"


class WorkerDeploySecretRecoveryContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads(CONTRACT.read_text())

    def test_exact_target_is_fixed(self):
        self.assertEqual(
            self.contract["target"],
            {
                "repository": "rozkalnsandris/rozkalns-control-center",
                "environment": "production-worker-deploy",
                "secret": "CONTROL_ACCESS_CLIENT_SECRET",
            },
        )

    def test_plaintext_secret_is_forbidden(self):
        policy = self.contract["input_policy"]
        self.assertTrue(policy["plaintext_secret_forbidden"])
        self.assertTrue(policy["encrypted_value_required"])
        self.assertTrue(policy["key_id_required"])
        self.assertTrue(policy["current_key_id_match_required"])

    def test_mutation_is_one_put_and_fail_closed(self):
        policy = self.contract["mutation_policy"]
        self.assertEqual(policy["maximum_put_requests"], 1)
        self.assertFalse(policy["retry_after_put_started"])
        self.assertFalse(policy["rollback_after_put_started"])
        self.assertFalse(policy["cleanup_after_put_started"])
        self.assertTrue(policy["fail_closed_on_ambiguous_result"])

    def test_post_update_keeps_live_gates_separate(self):
        policy = self.contract["post_update_policy"]
        self.assertTrue(policy["deploy_environment_get_only_verification_required"])
        self.assertTrue(policy["worker_deploy_requires_separate_owner_authorization"])
        self.assertTrue(policy["hermes_live_requires_separate_owner_authorization"])


if __name__ == "__main__":
    unittest.main()
