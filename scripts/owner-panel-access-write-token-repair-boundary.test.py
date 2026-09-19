#!/usr/bin/env python3
import pathlib
import unittest

WORKFLOW_PATH = pathlib.Path(__file__).parent.parent / ".github" / "workflows" / "owner-panel-access-write-token-repair.yml"
STAGED_PATH = pathlib.Path(__file__).with_name("owner-panel-access-write-token-repair-staged.py")


class AccessWriteTokenRepairBoundaryTests(unittest.TestCase):
    def blocks(self):
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        identity = workflow.split("  identity:\n", 1)[1].split("  repair:\n", 1)[0]
        repair = workflow.split("  repair:\n", 1)[1].split("  verify:\n", 1)[0]
        verify = workflow.split("  verify:\n", 1)[1]
        return workflow, identity, repair, verify

    def test_credentials_stay_in_their_own_environments(self):
        workflow, identity, repair, verify = self.blocks()
        self.assertIn("name: production-readonly-reconcile", identity)
        self.assertIn("name: production-access-token-policy-repair", repair)
        self.assertIn("name: production-readonly-reconcile", verify)

        self.assertIn("secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN", identity)
        self.assertIn("secrets.CLOUDFLARE_ACCESS_READ_TOKEN", identity)
        self.assertIn("secrets.CONTROL_ACCESS_CLIENT_ID", identity)
        self.assertNotIn("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN", identity)

        self.assertIn("secrets.CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN", repair)
        self.assertNotIn("secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN", repair)
        self.assertNotIn("secrets.CLOUDFLARE_ACCESS_READ_TOKEN", repair)
        self.assertNotIn("secrets.CONTROL_ACCESS_CLIENT_ID", repair)

        self.assertIn("secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN", verify)
        self.assertIn("secrets.CLOUDFLARE_ACCESS_READ_TOKEN", verify)
        self.assertIn("secrets.CONTROL_ACCESS_CLIENT_ID", verify)
        self.assertNotIn("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN", verify)
        self.assertEqual(workflow.count("name: production-access-token-policy-repair"), 1)

    def test_only_validated_token_id_crosses_environment_boundary(self):
        workflow, identity, repair, verify = self.blocks()
        self.assertIn("token_id: ${{ steps.readonly.outputs.token_id }}", identity)
        self.assertIn("TARGET_WRITE_TOKEN_ID: ${{ needs.identity.outputs.token_id }}", repair)
        self.assertIn("TARGET_WRITE_TOKEN_ID: ${{ needs.identity.outputs.token_id }}", verify)
        self.assertNotIn("CLOUDFLARE_ACCESS_WRITE_TOKEN: ${{ needs.", workflow)
        self.assertNotIn("CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN: ${{ needs.", workflow)

    def test_staged_helper_has_one_mutating_mode_and_two_get_only_modes(self):
        text = STAGED_PATH.read_text(encoding="utf-8")
        self.assertIn('mode == "--readonly-preflight"', text)
        self.assertIn('mode == "--management-put"', text)
        self.assertIn('mode == "--readonly-postverify"', text)
        self.assertIn('url == CORE.user_token_url(token_id)', text)
        self.assertNotIn("CORE.account_token_url", text)


if __name__ == "__main__":
    unittest.main()
