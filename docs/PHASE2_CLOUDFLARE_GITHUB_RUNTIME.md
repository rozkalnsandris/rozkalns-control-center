# Phase 2 Cloudflare GitHub read runtime boundary

Issue: #55  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Connect the already-reviewed GitHub App session, bounded REST/GraphQL transports and authoritative read provider to a Cloudflare Worker-compatible signing/configuration boundary without exposing a public live-data route or creating a Cloudflare Worker.

This change remains source-only. It does not upload a Worker version, create a deployment, configure the private-key value, enable a webhook, bind D1/Queues, or authorize production traffic.

## Live preflight evidence

The dedicated `Rozkalns Control` GitHub App read rollout is complete with exactly:

- Metadata read;
- Contents read;
- Issues read;
- Pull requests read;
- Checks read;
- Actions read.

`Commit statuses: read` remains conditional and is not enabled. `Administration: read` is not part of steady state.

A separately authorized Cloudflare read-only preflight used a short-lived account API token limited to `Workers Scripts Read`. The account token verified active, and the Worker inventory contained no uploaded Worker named `rozkalns-control`. Therefore there is no existing Control Worker version, deployment or script-secret binding to mutate.

First Worker/version creation remains a separate live Cloudflare resource mutation and is not part of issue #55.

## Cloudflare platform semantics rechecked

Current Cloudflare documentation confirms:

- `node:crypto` is supported in Workers when `nodejs_compat` is enabled; the existing Worker configuration already enables it with a sufficiently recent compatibility date;
- RSA/SHA-256 signing can use the native `node:crypto` signing API with private-key material supplied through a Worker binding;
- sensitive values belong in Worker secrets, not plaintext `vars`;
- Wrangler `secrets.required` stores only required secret names in source control, drives generated binding types, and causes future deploy/version-upload operations to fail when a required secret has not been configured;
- `wrangler secret put` creates and immediately deploys a new Worker version, so it is not an acceptable operation under a read-only/no-deploy gate;
- version upload and traffic deployment are separate operations and require their own later authorization.

Current GitHub REST documentation additionally requires every API request to carry a valid `User-Agent` and documents `403 Forbidden` for an invalid User-Agent. Cloudflare's own Workers examples for GitHub API calls explicitly add a `User-Agent` header. The runtime adapter therefore owns one fixed non-secret GitHub API identity, `Rozkalns-Control`, and injects it into every outbound GitHub request before calling the Worker fetch implementation.

## Runtime bindings

Non-secret configuration is source-controlled:

- `GITHUB_APP_CLIENT_ID` — GitHub App client identity;
- `GITHUB_APP_INSTALLATION_ID` — installation identity encoded as a positive decimal string.

Secret **name only** is source-controlled:

- `GITHUB_APP_PRIVATE_KEY_PEM`.

The private-key value itself must never appear in Git, D1, fixtures, screenshots, logs or documentation. It is intentionally absent from this repository.

## Signer boundary

`createCloudflareGitHubAppJwtSigner()` implements the existing `GitHubAppJwtSigner` interface. It receives private-key material only from the runtime binding and returns only signature bytes.

The existing session layer remains responsible for:

- constructing the bounded RS256 GitHub App JWT;
- short lifetime and clock-skew handling;
- exact installation token endpoint;
- repository/permission narrowing;
- returned scope verification;
- keeping raw JWT and installation-token material inside the integration/session boundary.

`createCloudflareGitHubCredentialFetch()` is the shared outbound HTTP adapter for installation-token exchange, authenticated REST reads and authenticated GraphQL reads. It preserves plain-function fetch receiver semantics and adds the fixed `User-Agent: Rozkalns-Control` header required by GitHub before forwarding the exact request. It does not change authorization, endpoint, method, body, repository/permission scope, redirect policy or retry behavior.

The Cloudflare adapter does not log or return key material, JWTs, installation credentials or remote response bodies.

## Read runtime composition

`createCloudflareGitHubReadRuntime()` composes:

1. Cloudflare-backed signer;
2. existing GitHub App REST/GraphQL authorized-session providers;
3. bounded REST GET transport;
4. fixed-query GraphQL merge-state transport;
5. authoritative GitHub read provider;
6. Metadata active branch-rules reader.

The factory uses the reviewed cumulative `actions` rollout stage, which contains the six approved read permissions and excludes the later conditional commit-status stage.

Each repository context narrows the installation token scope again to exactly one selected managed repository before any credential acquisition or network request.

The exposed branch-policy reader intentionally remains active-rules-only and therefore returns partial policy evidence. It does not invent classic branch-protection evidence or weaken the existing fail-closed reconciliation gate.

## Worker route boundary

Issue #55 deliberately does **not** import or invoke the runtime adapter from `src/worker/index.ts`.

The Worker still exposes only the existing health route. A future live read route must be separately designed, reviewed and authorized after the runtime source boundary is merged and an approved non-production/live resource setup exists.

## Validation contract

Deterministic tests prove:

- generated RSA key material can produce a signature verified with RSA/SHA-256;
- missing or unusable key material fails closed with sanitized errors;
- non-secret client/installation bindings are validated;
- the shared fetch adapter preserves plain-function receiver semantics and injects the exact GitHub User-Agent into token-exchange, REST and GraphQL requests;
- one repository context is narrowed to one managed repository with exactly the six approved read permissions;
- excluded repositories, invalid timestamps and mismatched reconciliation context fail before network access;
- `wrangler.jsonc` contains only the approved non-secret values plus the required secret name;
- Worker routing remains disconnected from the new runtime adapter;
- public-repository safety continues to reject actual secret material.

## Deploy impact

`DEPLOY_REQUIRED=no`.

No Worker version or Cloudflare production resource is created by this source-only change. A later first Worker/version + secret setup requires a separately scoped owner authorization.
