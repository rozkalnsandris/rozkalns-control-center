# Phase 2 authoritative GitHub read provider

Issue: #42  
PR: #43  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only provider composition

## Purpose

`src/integrations/github/authoritative-read-provider.ts` is the concrete GitHub implementation of the existing provider-neutral `SourceControlReadProvider`.

It does not create a new HTTP or authentication layer. It composes only:

- the bounded repository-scoped REST read transport merged through #30/#31;
- the fixed GraphQL pull-request merge-state transport merged through #37/#39;
- the existing fail-closed GitHub payload mappers and latest-effective evidence selectors;
- the generic authoritative snapshot reader and the #40/#41 commit-status coverage contract.

The Worker remains disconnected from this provider.

## One observation time

A provider instance is constructed with one explicit `observedAt` timestamp.

Every REST and GraphQL call made through that provider instance receives that same timestamp. `readGitHubAuthoritativePullRequestSnapshot(...)` then delegates to the generic snapshot reader with exactly that provider timestamp.

This prevents one logical snapshot from silently mixing different caller observation times.

It does not claim that GitHub returns every endpoint response atomically. Exact PR-head checks and fail-closed evidence rules remain necessary.

## Endpoint and permission binding

The provider builds only fixed repository-scoped relative REST paths and labels each request with the existing Phase 2 minimum read permission.

- repository metadata — `GET /repos/{owner}/{repo}` — `metadata: read`;
- default branch head — `GET /repos/{owner}/{repo}/branches/{branch}` — `contents: read`;
- open repository issues — `GET /repos/{owner}/{repo}/issues?state=open&per_page=100` — `issues: read`;
- open pull requests — `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` — `pull_requests: read`;
- one pull request — `GET /repos/{owner}/{repo}/pulls/{number}` — `pull_requests: read`;
- pull-request reviews — `GET /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100` — `pull_requests: read`;
- Check Runs for the exact head — `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?filter=all&per_page=100` — `checks: read`;
- commit statuses for the exact head — `GET /repos/{owner}/{repo}/commits/{sha}/statuses?per_page=100` — `statuses: read`;
- workflow runs for the exact head — `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=100` — `actions: read`;
- PR merge state — existing fixed `ControlPullRequestMergeState` GraphQL query — `pull_requests: read`.

The adapter cannot supply an origin, HTTP method, Authorization header, arbitrary GraphQL document or credential. Those capabilities remain owned by the previously reviewed transport/session boundaries.

## Issues versus pull requests

GitHub documents that repository issue listing can include pull requests because pull requests are also issues in the Issues API.

`listOpenIssues()` therefore excludes every entry carrying the `pull_request` marker before applying the normalized issue mapper.

It does not try to reinterpret a PR-shaped issue response as a normal issue.

## Check rerun evidence

The Check Runs endpoint defaults to its latest filter. Control already has latest-effective evidence logic that needs the available rerun history to reason conservatively.

The provider therefore explicitly requests `filter=all` and `per_page=100`, then passes the collected Check Runs through the existing exact-head/latest-effective selector.

Pagination remains bounded by the merged REST transport request budget and same-repository Link validation.

## Exact-head normalization

Check Runs, commit statuses and workflow runs are normalized through the existing exact-head evidence helpers.

The composed generic authoritative snapshot still reasserts that every returned Check/status/workflow item belongs to the observed PR head and that GraphQL merge-state evidence agrees with PR number, head SHA and draft state.

## Conditional commit statuses

`listCommitStatuses()` remains a normal concrete provider method and requires `statuses: read` when called.

It is **not** made universally mandatory.

When `readGitHubAuthoritativePullRequestSnapshot(...)` receives `commitStatusCoverage="NOT_REQUESTED"`, the merged #40 generic snapshot contract skips the provider status method entirely. A scope without `statuses: read` can therefore perform that source-only snapshot path without pretending commit statuses were authoritatively observed.

The projection still fails closed for required status-check contexts while coverage is `NOT_REQUESTED`.

## Fail-closed response handling

The provider rejects malformed or contradictory adapter-level payload shapes, including:

- repository identity mismatch;
- default-branch response naming a different branch;
- missing branch commit SHA;
- malformed pagination page shapes;
- an unexpected closed item returned from an explicitly open issue/PR collection;
- singular PR response with a different PR number;
- malformed Check/workflow wrapper arrays.

Existing REST/GraphQL transport errors remain intact, including auth, permission, rate-limit, pagination and credential-lease failures.

## Source-only boundary

This task adds no:

- real GitHub App creation or installation;
- repository selection or permission mutation;
- `statuses: read` or `administration: read` grant;
- live REST/GraphQL request;
- signer, private key, JWT, installation token or webhook secret;
- Worker GitHub route or live UI switch;
- Cloudflare secret, D1, Queue, DLQ or deployment;
- RPi5, production DB or host mutation;
- GitHub write capability;
- AI execution.

`DEPLOY_REQUIRED=no`.

## Official GitHub semantics rechecked 2026-08-11

The implementation was checked against current GitHub documentation for:

- REST API endpoints for repositories;
- REST API endpoints for branches;
- REST API endpoints for issues;
- REST API endpoints for pull requests;
- REST API endpoints for pull-request reviews;
- REST API endpoints for check runs;
- REST API endpoints for commit statuses;
- REST API endpoints for workflow runs.

The live rollout must re-check those semantics again at the exact canary step rather than treating this source document as permanent proof of future GitHub behavior.

## Validation

Initial PR CI #110 passed repository policy, runtime audit, typecheck and typed lint, then failed closed in test compilation because a local test case table was declared `readonly` and subsequently appended to.

Only the test helper declaration was corrected. Production provider code was unchanged.

Corrected source/test CI #111 passed:

- locked dependency install;
- repository policy / public-repo safety / Action pinning;
- runtime dependency audit;
- Wrangler type generation + TypeScript;
- typed production-source ESLint;
- all unit tests;
- Worker + SPA build;
- Wrangler dry-run.

## Current gate

Source/test implementation is green. Final docs-reconciled exact-head CI and owner merge decision remain separate gates.
