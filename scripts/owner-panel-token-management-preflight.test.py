#!/usr/bin/env python3
import importlib.util
import json
import pathlib

SCRIPT = pathlib.Path(__file__).with_name("owner-panel-token-management-preflight.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_token_management_preflight", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "1" * 32
GROUP_ID = "2" * 32
WRITE_TOKEN = "cfut_write_token_fixture"
MANAGEMENT_TOKEN = "cfut_management_token_fixture"


def payload(result):
    return {"success": True, "result": result}


def identity_send(method, url, token):
    assert method == "GET"
    assert url == MOD.REPAIR.VERIFY
    assert token == WRITE_TOKEN
    return payload({"id": TOKEN_ID, "status": "active"})


def management_send(method, url, token):
    assert method == "GET"
    assert token == MANAGEMENT_TOKEN
    if url == MOD.REPAIR.user_token_url(TOKEN_ID):
        return payload({"id": TOKEN_ID, "status": "active", "name": "target"})
    if url == MOD.REPAIR.permission_groups_url("USER_OWNED"):
        return {
            "success": True,
            "result": [{
                "id": GROUP_ID,
                "name": MOD.REPAIR.PERMISSION_NAME,
                "scopes": [MOD.REPAIR.PERMISSION_SCOPE],
            }],
        }
    raise AssertionError(url)


def test_identity_happy_path():
    receipt, token_id = MOD.identity_proof({"CLOUDFLARE_ACCESS_WRITE_TOKEN": WRITE_TOKEN}, identity_send)
    assert token_id == TOKEN_ID
    assert receipt == {
        "detail": "TOKEN_MANAGEMENT_IDENTITY_COMPLETE",
        "management_access": "NOT_PROVEN",
        "production_mutations": 0,
        "request_count": 1,
        "token_kind": "NOT_PROVEN",
        "write_token_status": "PROVEN_ACTIVE",
    }


def test_identity_missing_secret_is_network_silent():
    calls = []
    receipt, token_id = MOD.identity_proof({}, lambda *args: calls.append(args))
    assert receipt["detail"] == "WRITE_TOKEN_CREDENTIAL_UNAVAILABLE"
    assert receipt["request_count"] == 0
    assert receipt["production_mutations"] == 0
    assert token_id is None
    assert calls == []


def test_management_happy_path():
    receipt = MOD.management_proof({
        "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
        "TARGET_WRITE_TOKEN_ID": TOKEN_ID,
    }, management_send)
    assert receipt == {
        "detail": "TOKEN_MANAGEMENT_PREFLIGHT_COMPLETE",
        "management_access": "PROVEN_USER_TOKEN_DETAILS_AND_PERMISSION_GROUP",
        "production_mutations": 0,
        "request_count": 2,
        "token_kind": "USER_OWNED",
        "write_token_status": "BOUND_IDENTITY_OUTPUT",
    }


def test_management_missing_identity_is_network_silent():
    calls = []
    receipt = MOD.management_proof({
        "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
    }, lambda *args: calls.append(args))
    assert receipt["detail"] == "WRITE_TOKEN_IDENTITY_UNAVAILABLE"
    assert receipt["request_count"] == 0
    assert receipt["production_mutations"] == 0
    assert calls == []


def test_user_detail_403_is_bounded_without_account_fallback():
    calls = []

    def send(method, url, token):
        calls.append((method, url))
        if url == MOD.REPAIR.user_token_url(TOKEN_ID):
            raise MOD.REPAIR.ApiError(403)
        raise AssertionError(url)

    receipt = MOD.management_proof({
        "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
        "TARGET_WRITE_TOKEN_ID": TOKEN_ID,
    }, send)
    assert receipt["detail"] == "TOKEN_MANAGEMENT_PREFLIGHT_FAILED"
    assert receipt["preflight_class"] == "HTTP_403"
    assert receipt["request_count"] == 1
    assert receipt["production_mutations"] == 0
    assert all("/accounts/" not in url for _, url in calls)


def test_receipts_never_contain_secret_values():
    identity, _ = MOD.identity_proof({"CLOUDFLARE_ACCESS_WRITE_TOKEN": WRITE_TOKEN}, identity_send)
    management = MOD.management_proof({
        "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
        "TARGET_WRITE_TOKEN_ID": TOKEN_ID,
    }, management_send)
    rendered = json.dumps([identity, management], sort_keys=True)
    assert WRITE_TOKEN not in rendered
    assert MANAGEMENT_TOKEN not in rendered
    assert TOKEN_ID not in rendered


def test_workflow_boundary():
    workflow = SCRIPT.parent.parent / ".github/workflows/owner-panel-token-management-preflight.yml"
    text = workflow.read_text(encoding="utf-8")
    identity_block = text.split("  identity:", 1)[1].split("  management:", 1)[0]
    management_block = text.split("  management:", 1)[1]
    assert "production-readonly-reconcile" in identity_block
    assert "secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN" in identity_block
    assert "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN" not in identity_block
    assert "needs: identity" in management_block
    assert "production-access-token-policy-repair" in management_block
    assert "secrets.CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN" in management_block
    assert "CLOUDFLARE_ACCESS_WRITE_TOKEN" not in management_block
    assert "needs.identity.outputs.token_id" in management_block
    assert "CLOUDFLARE_ACCESS_READ_TOKEN" not in text
    assert "CONTROL_ACCESS_CLIENT" not in text


if __name__ == "__main__":
    for fn in (
        test_identity_happy_path,
        test_identity_missing_secret_is_network_silent,
        test_management_happy_path,
        test_management_missing_identity_is_network_silent,
        test_user_detail_403_is_bounded_without_account_fallback,
        test_receipts_never_contain_secret_values,
        test_workflow_boundary,
    ):
        fn()
    print("owner-panel-token-management-preflight: 7/7 OK")
