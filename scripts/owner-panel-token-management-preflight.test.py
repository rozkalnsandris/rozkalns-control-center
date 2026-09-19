#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import urllib.error

SCRIPT = pathlib.Path(__file__).with_name("owner-panel-token-management-preflight.py")
SPEC = importlib.util.spec_from_file_location("owner_panel_token_management_preflight", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)

TOKEN_ID = "1" * 32
GROUP_ID = "2" * 32
WRITE_TOKEN = "cfut_write_token_fixture"
MANAGEMENT_TOKEN = "cfut_management_token_fixture"
ENV = {
    "CLOUDFLARE_ACCESS_WRITE_TOKEN": WRITE_TOKEN,
    "CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN": MANAGEMENT_TOKEN,
}


def payload(result):
    return {"success": True, "result": result}


def happy_send(method, url, token):
    assert method == "GET"
    if url == MOD.REPAIR.VERIFY:
        assert token == WRITE_TOKEN
        return payload({"id": TOKEN_ID, "status": "active"})
    if url == MOD.REPAIR.user_token_url(TOKEN_ID):
        assert token == MANAGEMENT_TOKEN
        return payload({"id": TOKEN_ID, "status": "active", "name": "target"})
    if url == MOD.REPAIR.permission_groups_url("USER_OWNED"):
        assert token == MANAGEMENT_TOKEN
        return {
            "success": True,
            "result": [{
                "id": GROUP_ID,
                "name": MOD.REPAIR.PERMISSION_NAME,
                "scopes": [MOD.REPAIR.PERMISSION_SCOPE],
            }],
        }
    raise AssertionError(url)


def test_happy_path():
    receipt = MOD.proof(ENV, happy_send)
    assert receipt == {
        "detail": "TOKEN_MANAGEMENT_PREFLIGHT_COMPLETE",
        "management_access": "PROVEN_USER_TOKEN_DETAILS_AND_PERMISSION_GROUP",
        "production_mutations": 0,
        "request_count": 3,
        "token_kind": "USER_OWNED",
        "write_token_status": "PROVEN_ACTIVE",
    }


def test_missing_management_secret_is_network_silent():
    calls = []
    receipt = MOD.proof({"CLOUDFLARE_ACCESS_WRITE_TOKEN": WRITE_TOKEN}, lambda *args: calls.append(args))
    assert receipt["detail"] == "TOKEN_MANAGEMENT_CREDENTIAL_UNAVAILABLE"
    assert receipt["production_mutations"] == 0
    assert receipt["request_count"] == 0
    assert calls == []


def test_user_detail_403_is_bounded_without_account_fallback():
    calls = []

    def send(method, url, token):
        calls.append((method, url))
        if url == MOD.REPAIR.VERIFY:
            return payload({"id": TOKEN_ID, "status": "active"})
        if url == MOD.REPAIR.user_token_url(TOKEN_ID):
            raise MOD.REPAIR.ApiError(403)
        raise AssertionError(url)

    receipt = MOD.proof(ENV, send)
    assert receipt["detail"] == "TOKEN_MANAGEMENT_PREFLIGHT_FAILED"
    assert receipt["preflight_class"] == "HTTP_403"
    assert receipt["request_count"] == 2
    assert receipt["production_mutations"] == 0
    assert all("/accounts/" not in url for _, url in calls)


def test_receipt_never_contains_secret_values():
    rendered = json.dumps(MOD.proof(ENV, happy_send), sort_keys=True)
    assert WRITE_TOKEN not in rendered
    assert MANAGEMENT_TOKEN not in rendered


def test_workflow_boundary():
    workflow = SCRIPT.parent.parent / ".github/workflows/owner-panel-token-management-preflight.yml"
    text = workflow.read_text(encoding="utf-8")
    assert "production-access-token-policy-repair" in text
    assert "secrets.CLOUDFLARE_TOKEN_MANAGEMENT_TOKEN" in text
    assert "secrets.CLOUDFLARE_ACCESS_WRITE_TOKEN" in text
    assert "CLOUDFLARE_ACCESS_READ_TOKEN" not in text
    assert "CONTROL_ACCESS_CLIENT" not in text
    assert "owner-panel-token-management-preflight.py" in text


if __name__ == "__main__":
    for fn in (
        test_happy_path,
        test_missing_management_secret_is_network_silent,
        test_user_detail_403_is_bounded_without_account_fallback,
        test_receipt_never_contains_secret_values,
        test_workflow_boundary,
    ):
        fn()
    print("owner-panel-token-management-preflight: 5/5 OK")
