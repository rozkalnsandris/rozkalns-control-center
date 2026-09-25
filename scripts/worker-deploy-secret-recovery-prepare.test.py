#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "worker-deploy-secret-recovery-prepare.py"
CONTRACT = ROOT / ".github" / "worker-deploy-secret-recovery.json"


def load_helper():
    spec = importlib.util.spec_from_file_location("recovery_prepare", HELPER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_static_safety_contract() -> None:
    text = HELPER.read_text(encoding="utf-8")
    assert "crypto_box_seal" in text
    assert "O_EXCL" in text
    assert "0o600" in text
    assert "MAIN_SHA_DRIFT" in text
    assert "TARGET_SECRET_NOT_FOUND" in text
    assert "CREDENTIAL_JSON_PERMISSIONS_TOO_BROAD" in text
    assert "PLAINTEXT_EMITTED=NO" in text
    assert "CIPHERTEXT_EMITTED=NO" in text
    assert "GITHUB_MUTATION=NO" in text
    assert "/dispatches" not in text
    assert "gh workflow run" not in text
    assert "gh secret set" not in text
    assert "wrangler" not in text.lower()
    assert "cloudflare" not in text.lower()
    assert "print(client_secret" not in text
    assert "print(encrypted_value" not in text


def test_contract_target_is_exact() -> None:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert contract["target"] == {
        "repository": "rozkalnsandris/rozkalns-control-center",
        "environment": "production-worker-deploy",
        "secret": "CONTROL_ACCESS_CLIENT_SECRET",
    }
    assert contract["mutation_policy"]["maximum_put_requests"] == 1
    assert contract["mutation_policy"]["retry_after_put_started"] is False


def test_secure_output_is_0600_and_non_overwriting() -> None:
    helper = load_helper()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "dispatch.json"
        helper.secure_write_json(path, {"ref": "main", "inputs": {}})
        assert path.stat().st_mode & 0o777 == 0o600
        assert json.loads(path.read_text(encoding="utf-8"))["ref"] == "main"
        try:
            helper.secure_write_json(path, {"ref": "main"})
        except SystemExit as exc:
            assert exc.code == 1
        else:
            raise AssertionError("existing output must fail closed")


if __name__ == "__main__":
    test_static_safety_contract()
    test_contract_target_is_exact()
    test_secure_output_is_0600_and_non_overwriting()
    print("worker-deploy-secret-recovery-prepare tests: PASS")
