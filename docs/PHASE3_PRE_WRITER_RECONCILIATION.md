# Phase 3 pre-writer reconciliation contract

Tracked by #240 after the first production `REQUEST_CHANGES` canary in #238.

## Safety boundary

This source change does **not** authorize or perform:

- a production Worker deploy;
- GitHub App permission growth;
- another `REQUEST_CHANGES` attempt;
- D1 mutation or request replay;
- UI activation.

The first canary request id `phase3_ops_pr3_20260817T1902_7f3c` is terminal and non-replayable. Production D1 read-only evidence confirmed `FAILED / RECONCILIATION_FAILED` with no review evidence.

## Target identity preflight

A future canary must bind two different GitHub objects:

1. `issueNumber` resolves to a genuine normalized open issue;
2. `pullNumber` resolves to the exact open, non-draft, mergeable/clean PR.

`issueNumber === pullNumber` is rejected before any provider read. This is an operator/preflight protection, not a weakening of authoritative reconciliation. The GitHub provider continues to remove PR-marked records returned by the Issues API from `listOpenIssues()`.

`preflightNeedsChangesTarget()` additionally freezes and verifies:

- repository;
- issue number;
- PR number;
- exact head SHA;
- exact default-branch/base SHA;
- exact successful workflow-run id;
- one observation timestamp.

The preflight is read-only and must run before a new live mutation authorization is consumed.

## Classic branch-protection evidence

Current GitHub documentation for `GET /repos/{owner}/{repo}/branches/{branch}/protection` requires GitHub App repository permission **Administration: read**.

The documentation exposes `404 Resource not found`, but does not provide an authoritative response distinction between an unprotected branch and other not-found cases. Therefore Control must not interpret a classic-protection `404` as proof that classic protection is absent.

The ordinary branch read available with `Contents: read` is also insufficient for this purpose because GitHub's branch `protected` state can represent branch protection or rulesets. It cannot prove the absence of classic branch protection independently.

Consequently:

- the source contract can represent `administration: read` as an explicitly bounded read-only installation-token scope;
- the existing Phase 2 rollout stages do **not** add that permission;
- ordinary dashboard reads remain on the existing scope without Administration;
- Needs-changes creates a separate one-repository classic-protection scope;
- classic endpoint transport failures, including ambiguous 404 or permission rejection, fail closed;
- policy coverage becomes `COMPLETE` only after both `GITHUB_ACTIVE_RULES` and `GITHUB_CLASSIC_BRANCH_PROTECTION` observations exist for the exact same repository, branch and observation timestamp.

## Live permission state

Production GitHub App `Administration` remains **No access**.

After this source is merged, any production deploy remains a separate owner gate. Even after deploy, a Needs-changes execution cannot obtain complete classic evidence until any required live `Administration: read` permission growth is separately authorized and verified.

Do not silently grant that permission and do not spend a new `REQUEST_CHANGES` authorization before the permission/runtime prerequisites are complete.

## Regression coverage

The repository tests now cover:

- PR-marked Issues API records remain excluded from normalized open issues;
- equal issue/PR identities are rejected before target reads;
- missing genuine issue evidence blocks target preflight;
- stale head/base or unsuccessful exact workflow evidence blocks target preflight;
- classic branch-protection reads are fixed to the exact repository endpoint with `administration: read`;
- missing Administration scope blocks before transport;
- ambiguous classic read failures and malformed payloads fail closed;
- dashboard and Needs-changes scopes remain isolated;
- existing Needs-changes decision regression continues to prove complete evidence reaches the writer exactly once and partial policy evidence never reaches the writer.
