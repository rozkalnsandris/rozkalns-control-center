# Phase 2 GitHub App installation authentication contract

Issue: #26

This document defines the source-only authentication and REST-read transport boundary that must exist before Rozkalns Control creates or installs its dedicated GitHub App.

## Current scope

This phase is still source-only. It does not create a GitHub App, mint a JWT or installation token, add a secret, call GitHub over the network, change permissions, or deploy Cloudflare resources.

The contract exists so the later live adapter cannot invent a broader authentication model while being implemented.

## Official GitHub semantics rechecked 2026-08-11

Current GitHub documentation states that:

- an installation access token expires one hour after creation;
- the token may be narrowed to selected repositories that are already part of the installation;
- the token may be narrowed to a subset of permissions already granted to the App;
- GitHub Apps should request the minimum permissions required by the endpoints they actually call;
- current REST examples use API version `2026-03-10`;
- GitHub began a staged rollout in 2026 of a new stateless installation-token format, so callers must not depend on the legacy token length or shape.

All of these external semantics must be reverified immediately before live rollout. The API-version constant in source is an explicit reviewed assumption, not a permanent promise.

## Secret ownership boundary

Business/domain code must never receive raw GitHub credential material.

`GitHubInstallationReadTransport` therefore owns future credential acquisition and HTTP authentication internally. Callers provide only:

- installation scope;
- managed repository;
- required read permission;
- relative REST path;
- observation time.

The transport may return only sanitized lease evidence:

- installation ID;
- selected repositories;
- effective read permissions;
- issuance time;
- expiry time.

Raw token, JWT, private key and authentication-header material are not part of the public contract and must not be persisted in D1, logs, fixtures, issue evidence or UI state.

## Repository scope

Every repository in a requested installation-token scope must resolve through the existing managed-project allow-list.

The contract rejects:

- unmanaged repositories;
- the explicitly excluded `rozkalnsandris/hermes-email-skill` repository;
- duplicate repositories, including case-only duplicates;
- empty scopes;
- scopes larger than GitHub's documented 500-repository token-narrowing limit.

A later live App installation must also be selected-repositories-only unless a separately reviewed decision changes that rule.

## Permission scope

The source contract currently allows only these read permissions:

- `actions`;
- `checks`;
- `contents`;
- `issues`;
- `metadata`;
- `pull_requests`;
- `statuses`.

Any non-read access fails closed.

`administration` is deliberately absent. Classic branch-protection reads may eventually require Repository Administration read, but the roadmap requires a Metadata-read active-rules canary first and a separate authorization if Administration read remains necessary. The source contract must not pre-authorize that expansion.

## Credential lifetime

Sanitized lease evidence must prove a short-lived credential:

- expiry is after issuance;
- lifetime does not exceed the documented one-hour installation-token contract, allowing only a tiny clock/serialization tolerance;
- at least 60 seconds of lifetime must remain before a request is allowed.

If any of these facts are unknown, malformed or stale, the request fails closed and a future live adapter must mint/reacquire a fresh credential rather than proceed with uncertain authentication state.

## REST request boundary

A `GitHubReadRequest` is deliberately narrower than a generic HTTP request.

It contains only:

- managed repository;
- relative repository REST path;
- required approved read permission;
- reviewed API version.

The caller cannot provide:

- an authentication header;
- an arbitrary host/base URL;
- a write HTTP method;
- a credential value.

The relative path must remain inside the same managed repository named by the request.

## Token-format independence

No source code may require a specific installation-token length, prefix or legacy shape. GitHub's 2026 stateless-token rollout makes those assumptions invalid and unnecessary.

The token is an opaque secret owned by the future authentication implementation. Only expiry and sanitized scope metadata are relevant outside that implementation.

## Live rollout prerequisites

Before implementing the real transport:

1. re-read master issue #1 and current `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md`;
2. re-check the current GitHub REST API version and installation-token semantics;
3. create a separate `Rozkalns Control` GitHub App rather than broadening `Rozkalns Automation`;
4. prove the exact REST/GraphQL endpoint permission set with a selected-repository read-only canary;
5. test active branch rules with Metadata read before proposing Administration read;
6. request `Commit statuses: read` only if actual managed repositories require that evidence;
7. store the App private key and generated credentials only in approved secret/runtime storage;
8. keep all GitHub mutation permissions absent in Phase 2.

## Security invariants

- Missing or ambiguous scope fails closed.
- Unmanaged repositories fail closed.
- Write permission fails closed.
- Unapproved high-privilege permission fails closed.
- Stale/near-expiry credential evidence fails closed.
- Credential evidence is redacted by construction.
- No token-format assumption is permitted.
- No live transport exists in this source-only task.
- Merge authorization remains unrelated to deploy authorization.
