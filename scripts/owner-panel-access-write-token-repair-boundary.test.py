#!/usr/bin/env python3
import pathlib
import unittest

WORKFLOW_PATH = pathlib.Path(__file__).parent.parent / ".github" / "workflows" / "owner-panel-access-write-token-repair.yml"


class AccessWriteTokenRepairBoundaryTests(unittest.TestCase):
    def test_repair_uses_dedicated_mutation_environment(self):
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        self.assertIn("name: production-access-token-policy-repair", workflow)
        self.assertNotIn("name: production-readonly-reconcile", workflow)

    def test_repair_uses_dedicated_management_secret(self):
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN }}",
            workflow,
        )
        self.assertNotIn(
            "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
            workflow,
        )
        self.assertIn("CLOUDFLARE_ACCESS_WRITE_TOKEN", workflow)
        self.assertIn("CLOUDFLARE_ACCESS_READ_TOKEN", workflow)


if __name__ == "__main__":
    unittest.main()
