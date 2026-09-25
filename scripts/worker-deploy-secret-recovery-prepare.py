#!/usr/bin/env python3
"""Prepare (but never dispatch) the reviewed Worker deploy secret-recovery input.

This helper performs read-only GitHub preflight, encrypts the recovered Access
client secret with the current GitHub environment public key using libsodium
sealed-box encryption, and writes a mode-0600 workflow_dispatch JSON payload.
It never prints plaintext/ciphertext and never performs a GitHub mutation.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / ".github" / "worker-deploy-secret-recovery.json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def stop(reason: str) -> "NoReturn":
    print("WORKER_DEPLOY_SECRET_RECOVERY_PREPARE=STOP", file=sys.stderr)
    print(f"STOP={reason}", file=sys.stderr)
    print("GITHUB_MUTATION=NO", file=sys.stderr)
    raise SystemExit(1)


def gh_get(repo: str, path: str) -> dict[str, Any]:
    proc = subprocess.run(
        ["gh", "api", f"repos/{repo}{path}"],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        stop("GITHUB_GET_FAILED")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        stop("GITHUB_GET_INVALID_JSON")
    if not isinstance(result, dict):
        stop("GITHUB_GET_INVALID_SHAPE")
    return result


def secure_write_json(path: Path, payload: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        stop("OUTPUT_ALREADY_EXISTS")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink(missing_ok=True)
        finally:
            stop("OUTPUT_WRITE_FAILED")


def seal_secret(plaintext: bytes, public_key_b64: str) -> str:
    lib_name = ctypes.util.find_library("sodium")
    if not lib_name:
        stop("LIBSODIUM_NOT_FOUND")
    sodium = ctypes.CDLL(lib_name)
    sodium.sodium_init.restype = ctypes.c_int
    if sodium.sodium_init() < 0:
        stop("LIBSODIUM_INIT_FAILED")

    sodium.crypto_box_publickeybytes.restype = ctypes.c_size_t
    sodium.crypto_box_sealbytes.restype = ctypes.c_size_t
    public_key_bytes = int(sodium.crypto_box_publickeybytes())
    seal_bytes = int(sodium.crypto_box_sealbytes())

    try:
        public_key = base64.b64decode(public_key_b64, validate=True)
    except Exception:
        stop("PUBLIC_KEY_BASE64_INVALID")
    if len(public_key) != public_key_bytes:
        stop("PUBLIC_KEY_LENGTH_INVALID")

    out = (ctypes.c_ubyte * (len(plaintext) + seal_bytes))()
    msg = (ctypes.c_ubyte * len(plaintext)).from_buffer_copy(plaintext)
    key = (ctypes.c_ubyte * len(public_key)).from_buffer_copy(public_key)
    sodium.crypto_box_seal.argtypes = [
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.c_ulonglong,
        ctypes.POINTER(ctypes.c_ubyte),
    ]
    sodium.crypto_box_seal.restype = ctypes.c_int
    if sodium.crypto_box_seal(out, msg, len(plaintext), key) != 0:
        stop("SEALED_BOX_ENCRYPTION_FAILED")
    return base64.b64encode(bytes(out)).decode("ascii")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-main", required=True)
    parser.add_argument("--credential-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if not SHA_RE.fullmatch(args.expected_main):
        stop("EXPECTED_MAIN_INVALID")

    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    target = contract.get("target", {})
    source_policy = contract.get("source_policy", {})
    mutation_policy = contract.get("mutation_policy", {})
    repo = target.get("repository")
    environment = target.get("environment")
    secret_name = target.get("secret")
    if (
        repo != "rozkalnsandris/rozkalns-control-center"
        or environment != "production-worker-deploy"
        or secret_name != "CONTROL_ACCESS_CLIENT_SECRET"
        or source_policy.get("dispatch_ref") != "main"
        or mutation_policy.get("maximum_put_requests") != 1
        or mutation_policy.get("retry_after_put_started") is not False
    ):
        stop("RECOVERY_CONTRACT_INVALID")

    main_state = gh_get(repo, "/branches/main")
    observed_main = main_state.get("commit", {}).get("sha")
    if observed_main != args.expected_main:
        stop("MAIN_SHA_DRIFT")

    public_key_state = gh_get(
        repo, f"/environments/{environment}/secrets/public-key"
    )
    key_id = public_key_state.get("key_id")
    public_key = public_key_state.get("key")
    if not isinstance(key_id, str) or not key_id:
        stop("PUBLIC_KEY_ID_INVALID")
    if not isinstance(public_key, str) or not public_key:
        stop("PUBLIC_KEY_INVALID")

    target_state = gh_get(
        repo, f"/environments/{environment}/secrets/{secret_name}"
    )
    if target_state.get("name") != secret_name:
        stop("TARGET_SECRET_NOT_FOUND")

    try:
        mode = args.credential_json.stat().st_mode & 0o777
    except FileNotFoundError:
        stop("CREDENTIAL_JSON_NOT_FOUND")
    if mode & 0o077:
        stop("CREDENTIAL_JSON_PERMISSIONS_TOO_BROAD")

    try:
        credential = json.loads(args.credential_json.read_text(encoding="utf-8"))
    except Exception:
        stop("CREDENTIAL_JSON_INVALID")
    client_secret = credential.get("client_secret") if isinstance(credential, dict) else None
    if not isinstance(client_secret, str) or not client_secret:
        stop("CLIENT_SECRET_MISSING")

    encrypted_value = seal_secret(client_secret.encode("utf-8"), public_key)
    owner_authorization = (
        "AUTHORIZE_WORKER_DEPLOY_SECRET_RECOVERY:"
        f"{args.expected_main}:{environment}:{secret_name}:PUT1:NO-RETRY"
    )
    payload = {
        "ref": "main",
        "inputs": {
            "owner_authorization": owner_authorization,
            "encrypted_value": encrypted_value,
            "key_id": key_id,
        },
    }
    secure_write_json(args.output, payload)

    print("WORKER_DEPLOY_SECRET_RECOVERY_PREPARE=PASS")
    print(f"MAIN_SHA={args.expected_main}")
    print(f"TARGET_ENVIRONMENT={environment}")
    print(f"TARGET_SECRET={secret_name}")
    print(f"OUTPUT_MODE={oct(args.output.stat().st_mode & 0o777)}")
    print("PLAINTEXT_EMITTED=NO")
    print("CIPHERTEXT_EMITTED=NO")
    print("GITHUB_MUTATION=NO")
    print("NEXT=OWNER_AUTHORIZED_WORKFLOW_DISPATCH")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
