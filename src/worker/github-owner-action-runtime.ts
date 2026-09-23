import type { CloudflareAccessJwksFetch } from "../integrations/cloudflare/access-jwks-resolver.js";
import { createCloudflareGitHubAppJwtSigner, createCloudflareGitHubCredentialFetch, createCloudflareGitHubReadRuntime, type CloudflareGitHubRuntimeBindings } from "../integrations/github/cloudflare-worker-runtime.js";
import { GITHUB_APP_JWT_ALGORITHM, GITHUB_APP_JWT_CLOCK_SKEW_SECONDS, GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS, type GitHubAppCredentialFetch, type GitHubAppJwtSigner } from "../integrations/github/app-installation-session.js";
import { GITHUB_REST_API_VERSION } from "../integrations/github/app-installation-read-contract.js";
import { GITHUB_REST_ACCEPT, GITHUB_REST_ORIGIN } from "../integrations/github/rest-read-transport.js";
import { CloudflareAccessRequestAuthenticator, type CloudflareAccessRequestAuthenticatorConfig } from "./access-request-authenticator.js";
import { OwnerActionRuntimeError, type OwnerActionDispatchInput, type OwnerActionDispatchResult, type OwnerActionWorkerRuntime } from "./github-owner-action-route.js";

export interface CloudflareOwnerActionBindings extends CloudflareGitHubRuntimeBindings { readonly CONTROL_MERGE_ACCESS_ISSUER: string; readonly CONTROL_MERGE_ACCESS_AUDIENCE: string; }
export interface CloudflareOwnerActionOptions { readonly bindings: CloudflareOwnerActionBindings; readonly access: CloudflareAccessRequestAuthenticatorConfig; readonly githubFetch?: GitHubAppCredentialFetch; readonly accessFetch?: CloudflareAccessJwksFetch; readonly clock?: () => Date; }

function nonEmpty(value: unknown): string | null { return typeof value === "string" && value.trim() !== "" && value === value.trim() && !/[\r\n]/.test(value) ? value : null; }
function issuer(value: unknown): string | null { const raw = nonEmpty(value); if (!raw) return null; try { const url = new URL(raw); return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password ? url.origin : null; } catch { return null; } }
function b64(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function b64json(value: unknown) { return b64(new TextEncoder().encode(JSON.stringify(value))); }
async function appJwt(clientId: string, nowMs: number, signer: GitHubAppJwtSigner) { const seconds = Math.floor(nowMs / 1000); const header = b64json({ alg: GITHUB_APP_JWT_ALGORITHM, typ: "JWT" }); const body = b64json({ iat: seconds - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS, exp: seconds + GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS, iss: clientId }); const input = `${header}.${body}`; const signature = await signer.signRs256(new TextEncoder().encode(input)); return `${input}.${b64(signature)}`; }
function repoName(repository: string) { const parts = repository.split("/"); if (parts.length !== 2 || !parts[1]) throw new OwnerActionRuntimeError("DISPATCH_REJECTED"); return parts[1]; }
async function jsonBody(response: Response): Promise<Record<string, unknown>> { const value: unknown = await response.json().catch(() => null); if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnerActionRuntimeError("DISPATCH_REJECTED"); return value as Record<string, unknown>; }

async function acquireActionsToken(repository: string, clientId: string, installationId: number, signer: GitHubAppJwtSigner, fetchRequest: GitHubAppCredentialFetch, nowMs: number): Promise<string> {
  const jwt = await appJwt(clientId, nowMs, signer);
  let response: Response; try { response = await fetchRequest(new Request(`${GITHUB_REST_ORIGIN}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: { Accept: GITHUB_REST_ACCEPT, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", "X-GitHub-Api-Version": GITHUB_REST_API_VERSION }, body: JSON.stringify({ repositories: [repoName(repository)], permissions: { actions: "write", contents: "read" } }), redirect: "manual" })); } catch { throw new OwnerActionRuntimeError("DISPATCH_OUTCOME_UNKNOWN"); }
  if (response.status === 403 || response.status === 422) throw new OwnerActionRuntimeError("ACTIONS_PERMISSION_REQUIRED"); if (response.status !== 201) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
  const body = await jsonBody(response); if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
  const repositories = body.repositories; if (!Array.isArray(repositories) || repositories.length !== 1 || typeof repositories[0] !== "object" || repositories[0] === null || (repositories[0] as Record<string, unknown>).full_name?.toString().toLowerCase() !== repository.toLowerCase()) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
  const permissions = body.permissions; if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new OwnerActionRuntimeError("ACTIONS_PERMISSION_REQUIRED"); const permission = permissions as Record<string, unknown>; if (permission.actions !== "write" || permission.contents !== "read") throw new OwnerActionRuntimeError("ACTIONS_PERMISSION_REQUIRED");
  const expiry = Date.parse(body.expires_at); if (!Number.isFinite(expiry) || expiry <= nowMs + 60_000 || expiry - nowMs > 3_700_000) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
  return body.token;
}

async function authorizedFetch(fetchRequest: GitHubAppCredentialFetch, token: string, url: string, init: RequestInit): Promise<Response> {
  try { const headers = new Headers(init.headers); headers.set("Accept", GITHUB_REST_ACCEPT); headers.set("Authorization", `Bearer ${token}`); headers.set("X-GitHub-Api-Version", GITHUB_REST_API_VERSION); return await fetchRequest(new Request(url, { ...init, headers, redirect: "manual" })); } catch { throw new OwnerActionRuntimeError("DISPATCH_OUTCOME_UNKNOWN"); }
}

export function createCloudflareOwnerActionRuntime(options: CloudflareOwnerActionOptions): OwnerActionWorkerRuntime {
  const clock = options.clock ?? (() => new Date()); const readRuntime = createCloudflareGitHubReadRuntime({ bindings: options.bindings, ...(options.githubFetch === undefined ? {} : { fetchRequest: options.githubFetch }) }); const fetchRequest = createCloudflareGitHubCredentialFetch(options.githubFetch); const signer = createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const authenticator = new CloudflareAccessRequestAuthenticator(options.access, { ...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }), clock });
  return { authenticator, async dispatch(input: OwnerActionDispatchInput): Promise<OwnerActionDispatchResult> {
    const now = clock(); if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(input.target.workflow) || !/^[A-Za-z0-9._/-]+$/.test(input.target.ref)) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
    const token = await acquireActionsToken(input.repository, readRuntime.clientId, readRuntime.installationId, signer, fetchRequest, now.getTime());
    const repoResponse = await authorizedFetch(fetchRequest, token, `${GITHUB_REST_ORIGIN}/repos/${input.repository}`, { method: "GET" }); if (repoResponse.status !== 200) throw new OwnerActionRuntimeError("DISPATCH_REJECTED"); const repo = await jsonBody(repoResponse); if (repo.default_branch !== input.target.ref) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
    const branchResponse = await authorizedFetch(fetchRequest, token, `${GITHUB_REST_ORIGIN}/repos/${input.repository}/branches/${encodeURIComponent(input.target.ref)}`, { method: "GET" }); if (branchResponse.status !== 200) throw new OwnerActionRuntimeError("DISPATCH_REJECTED"); const branch = await jsonBody(branchResponse); const commit = branch.commit; if (!commit || typeof commit !== "object" || Array.isArray(commit) || typeof (commit as Record<string, unknown>).sha !== "string") throw new OwnerActionRuntimeError("DISPATCH_REJECTED"); const observedMainSha = (commit as Record<string, unknown>).sha as string; if (observedMainSha !== input.expectedMainSha) throw new OwnerActionRuntimeError("STALE_MAIN_SHA");
    const dispatch = await authorizedFetch(fetchRequest, token, `${GITHUB_REST_ORIGIN}/repos/${input.repository}/actions/workflows/${encodeURIComponent(input.target.workflow)}/dispatches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: input.target.ref, inputs: { control_action: input.action, expected_main_sha: input.expectedMainSha, control_request_id: input.requestId } }) }); if (dispatch.status !== 204) throw new OwnerActionRuntimeError("DISPATCH_REJECTED");
    return { status: "DISPATCHED", action: input.action, repository: input.repository, workflow: input.target.workflow, ref: input.target.ref, expectedMainSha: input.expectedMainSha, observedMainSha, requestId: input.requestId };
  } };
}

export function resolveCloudflareOwnerActionRuntime(bindings: CloudflareOwnerActionBindings): OwnerActionWorkerRuntime | null { const accessIssuer = issuer(bindings.CONTROL_MERGE_ACCESS_ISSUER); const audience = nonEmpty(bindings.CONTROL_MERGE_ACCESS_AUDIENCE); if (!accessIssuer || !audience) return null; try { return createCloudflareOwnerActionRuntime({ bindings, access: { issuer: accessIssuer, audience } }); } catch { return null; } }
