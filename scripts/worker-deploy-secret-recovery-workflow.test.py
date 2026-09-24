from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/worker-deploy-secret-recovery-preflight.yml"


class WorkerDeploySecretRecoveryWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()

    def test_exact_target_and_admin_boundary_are_fixed(self):
        self.assertIn("TARGET_ENVIRONMENT: production-worker-deploy", self.text)
        self.assertIn("TARGET_SECRET: CONTROL_ACCESS_CLIENT_SECRET", self.text)
        self.assertIn("name: production-secret-admin", self.text)
        self.assertIn("SECRET_ADMIN_TOKEN: ${{ secrets.CONTROL_SECRET_ADMIN_TOKEN }}", self.text)

    def test_plaintext_target_secret_is_never_read(self):
        self.assertNotIn("secrets.CONTROL_ACCESS_CLIENT_SECRET", self.text)
        self.assertIn("ENCRYPTED_VALUE: ${{ inputs.encrypted_value }}", self.text)
        self.assertIn("KEY_ID: ${{ inputs.key_id }}", self.text)

    def test_current_main_key_and_existing_secret_are_revalidated(self):
        self.assertIn("'/branches/main'", self.text)
        self.assertIn("/secrets/public-key", self.text)
        self.assertIn("PUBLIC_KEY_ID_DRIFT", self.text)
        self.assertIn("/secrets/${TARGET_SECRET}", self.text)
        self.assertIn("TARGET_SECRET_NOT_FOUND", self.text)

    def test_secret_update_is_exactly_one_no_retry_put(self):
        self.assertEqual(self.text.count("-X PUT"), 1)
        self.assertIn("--retry 0", self.text)
        self.assertIn("SECRET_PUT_COUNT=1", self.text)
        self.assertIn("NO_RETRY_ROLLBACK_CLEANUP=YES", self.text)
        self.assertIn("SECRET_PUT_RESULT_UNCERTAIN", self.text)
        self.assertIn("SECRET_PUT_UNEXPECTED_HTTP_", self.text)

    def test_live_steps_remain_outside_recovery_workflow(self):
        for forbidden in (
            "wrangler deploy",
            "wrangler versions deploy",
            "cloudflare",
            "hermes-deals",
            "d1",
            "queue",
        ):
            self.assertNotIn(forbidden, self.text.lower())
        self.assertIn("NEXT=DEPLOY_ENVIRONMENT_GET_ONLY_VERIFICATION", self.text)


if __name__ == "__main__":
    unittest.main()
