#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const USER_TOKEN_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";
const API_ROOT = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function failure(code, httpStatus = null) {
  return {
    schema_version: 1,
    ok: false,
    code,
    http_status: Number.isInteger(httpStatus) ? httpStatus : null,
  };
}

async function getJson(url, token, fetchImpl, codes, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { error: failure(codes.network) };
  }

  if (response.status !== 200) {
    return { error: failure(codes.http, response.status) };
  }

  try {
    return { payload: await response.json() };
  } catch {
    return { error: failure(codes.json) };
  }
}

function tokenVerifyUrls(token, accountId) {
  const accountUrl = `${API_ROOT}/accounts/${accountId}/tokens/verify`;
  if (token.startsWith("cfat_")) return [accountUrl];
  if (token.startsWith("cfut_")) return [USER_TOKEN_VERIFY_URL];
  return [USER_TOKEN_VERIFY_URL, accountUrl];
}

async function verifyToken(token, accountId, fetchImpl, timeoutMs) {
  const urls = tokenVerifyUrls(token, accountId);
  for (let index = 0; index < urls.length; index += 1) {
    const verify = await getJson(urls[index], token, fetchImpl, {
      network: "WORKERS_WRITE_CREDENTIAL_VERIFY_NETWORK_FAILED",
      http: "WORKERS_WRITE_CREDENTIAL_VERIFY_HTTP_NOT_200",
      json: "WORKERS_WRITE_CREDENTIAL_VERIFY_JSON_INVALID",
    }, timeoutMs);
    if (verify.error) {
      if (verify.error.http_status === 401 && index + 1 < urls.length) continue;
      return verify.error;
    }
    if (verify.payload?.success !== true || verify.payload?.result?.status !== "active") {
      return failure("WORKERS_WRITE_CREDENTIAL_TOKEN_NOT_ACTIVE");
    }
    return null;
  }
  return failure("WORKERS_WRITE_CREDENTIAL_VERIFY_HTTP_NOT_200", 401);
}

export async function runWriteCredentialPreflight({
  token,
  accountId,
  workerName,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  if (
    !token ||
    !ACCOUNT_ID.test(accountId ?? "") ||
    !WORKER_NAME.test(workerName ?? "") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return failure("WORKERS_WRITE_CREDENTIAL_PREFLIGHT_INPUT_INVALID");
  }

  const verifyFailure = await verifyToken(token, accountId, fetchImpl, timeoutMs);
  if (verifyFailure) return verifyFailure;

  const targetUrl = `${API_ROOT}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/versions?per_page=1`;
  const target = await getJson(targetUrl, token, fetchImpl, {
    network: "WORKERS_WRITE_CREDENTIAL_TARGET_READ_NETWORK_FAILED",
    http: "WORKERS_WRITE_CREDENTIAL_TARGET_READ_HTTP_NOT_200",
    json: "WORKERS_WRITE_CREDENTIAL_TARGET_READ_JSON_INVALID",
  }, timeoutMs);
  if (target.error) return target.error;
  if (target.payload?.success !== true || !Array.isArray(target.payload?.result?.items)) {
    return failure("WORKERS_WRITE_CREDENTIAL_TARGET_READ_INVALID");
  }

  return {
    schema_version: 1,
    ok: true,
    token_status: "ACTIVE",
    target_read: "PASS",
    write_permission_proven: false,
  };
}

async function cli() {
  const receipt = await runWriteCredentialPreflight({
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    workerName: process.env.PHASE5_WORKER_NAME ?? "",
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!receipt.ok) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stdout.write(`${JSON.stringify(failure("WORKERS_WRITE_CREDENTIAL_PREFLIGHT_UNEXPECTED_ERROR"))}\n`);
    process.exitCode = 2;
  });
}
