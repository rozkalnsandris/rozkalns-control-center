# CI runtime vulnerability audit fallback

## Purpose

The runtime dependency gate keeps `npm audit --omit=dev --audit-level=high` as the primary security check while removing npm's Bulk Advisory endpoint as a single availability dependency for pull-request CI.

This fallback changes availability behavior only. It does not weaken the vulnerability threshold, suppress findings, add `continue-on-error`, or authorize any production/LIVE mutation.

## Decision flow

1. Run the primary npm audit with the repository's bounded transport settings.
2. A successful npm audit is PASS.
3. Any npm vulnerability or other non-transport failure is immediate FAIL. Fallback is not allowed.
4. Explicit npm network/HTTP 5xx failures may retry within the existing three-attempt budget.
5. Only after all three attempts are classified as transport failures may the GitHub Advisory Database fallback run.
6. Fallback PASS requires a complete clean scan. Any ambiguity or provider error is FAIL.

The fallback therefore cannot turn an observed npm vulnerability result into PASS.

## Runtime dependency set

The fallback reads `package-lock.json` lockfile v3 and includes entries whose `dev` flag is not `true`. npm documents `dev: true` as packages that are strictly in the development dependency tree, so this preserves the primary command's `--omit=dev` intent.

Each runtime entry must resolve to the npm registry and provide an exact version. Linked, non-registry, malformed, unsupported-lock-version, or otherwise ambiguous runtime entries fail closed instead of being skipped.

Duplicate exact `package@version` identities are deduplicated before querying.

## Independent advisory source

Fallback provider: GitHub Global Security Advisories REST API.

For each bounded chunk of exact npm `package@version` identities the fallback queries:

- `type=reviewed&severity=high`;
- `type=reviewed&severity=critical`;
- `type=malware`.

All requests also bind `ecosystem=npm` and `is_withdrawn=false`.

Any returned reviewed high/critical advisory or malware advisory is FAIL. Pagination is followed only on `https://api.github.com/advisories` and is bounded. Unexpected response type/severity, malformed JSON, HTTP failure, timeout, pagination drift, or page-budget exhaustion is FAIL.

GitHub's documented `affects` filter performs the exact package/version matching; the repository does not implement a second vulnerable-range parser.

## Token boundary

CI exposes the existing ephemeral Actions `GITHUB_TOKEN` only to the `Audit runtime dependencies` step. Repository permissions remain `contents: read`; the Global Security Advisories endpoint itself requires no additional permission.

Before launching the primary npm audit subprocess, the wrapper removes `GITHUB_TOKEN` and `GH_TOKEN` from that subprocess environment. The token is used only for GitHub API rate-limit reliability if fallback is actually activated and is never printed.

No new secret, repository permission, GitHub App permission, or production credential is introduced.

## Observable results

Primary success:

`AUDIT_RUNTIME_RESULT=PASS`

Fallback activation after transport exhaustion:

`AUDIT_RUNTIME_TRANSPORT_EXHAUSTED=YES`
`AUDIT_RUNTIME_FALLBACK=GITHUB_ADVISORY_DATABASE`

Clean fallback:

`AUDIT_RUNTIME_RESULT=PASS_FALLBACK`

Security finding:

`AUDIT_RUNTIME_RESULT=FAIL_FALLBACK_VULNERABLE`

Provider/schema/lock uncertainty:

`AUDIT_RUNTIME_RESULT=FAIL_FALLBACK_ERROR`

Finding output is bounded to advisory identifiers/severity and never includes tokens or request headers.

## Official contracts verified for this change

- npm `package-lock.json`: `dev: true` marks packages strictly in the development dependency tree.
- npm `audit`: `--audit-level=high` changes the non-zero exit threshold; it does not filter report contents.
- GitHub Global Security Advisories REST: public global-advisory reads support `ecosystem`, `severity`, `type`, `is_withdrawn`, and `affects=package@version`; `affects` accepts up to 1000 package identities, subject to URL-size limits.

The implementation deliberately uses smaller chunks and bounded pagination.
