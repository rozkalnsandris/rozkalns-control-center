# AUTO-RUN FULL v2 — Rozkalns Control Center

This is the repository-local full implementation contract for explicit commands of the form:

`AUTO-RUN FULL rozkalns-control-center #<issue>`

Issue #1, canonical operational handoff #278, `AGENTS.md`, and any stricter phase-specific trust-boundary contract remain authoritative. GitHub is canonical; chat history is not continuation state.

## Role of FULL vs FAST

`AUTO-RUN FULL` is the normal lane for a concrete issue that should be implemented end-to-end at the **source + merge** layer.

FAST-LANE v2.2 remains the safe discovery, audit and non-FULL continuation lane. Bare `START`, `START rozkalns-control-center`, and `turpini` stay FAST. FULL is never inferred from issue state, #278, #497, a prior receipt, controller state, or chat history.

## One-command source flow

A valid FULL activation targets exactly one open issue and aims to complete:

`fresh GitHub state -> durable activation receipt -> post-receipt main stability -> controller activation -> branch -> source/tests/docs -> Draft PR -> CI/review -> scope-preserving corrections -> frozen exact head -> guarded merge -> exact target issue closed -> exact-main verification -> final receipt`

Routine CI failure, review findings, ordinary merge conflict resolution, session end and read-only polling are technical continuation states, not owner gates.

## Activation and durable authority

Before the first source mutation, read at minimum:

- issue #1;
- issue #278;
- `AGENTS.md`;
- `.github/start-mode-routing.json`;
- `.github/auto-run-full-v2.json`;
- the exact target issue;
- current `main`;
- relevant active PR/CI/review/dependency state;
- controller #499.

Persist an immutable target-issue authorization receipt before branch/source/PR/merge work. It freezes the repository, issue, Definition of Done, activation main SHA, allowed source actions, merge authority, retry semantics and explicit live exclusions.

Immediately after the receipt write, re-read `main`. Source authority becomes usable only when the post-write main SHA still equals the receipt's activation SHA.

Main-only drift before source mutation can use the bounded superseding-receipt procedure from the machine contract. Scope, repository-rule or trust-boundary drift is not harmless main drift and requires STOP.

## Controller

Issue #499 is the durable active-target pointer. It is evidence/state only and never creates authority by itself.

At most one FULL target may be active. A worker must reconstruct current state from GitHub rather than rely on the previous chat/session.

## Hybrid exact-head merge v2

The merge path deliberately differs from the first RPi5/Deals v2 draft.

GitHub native auto-merge is useful only while a PR cannot merge immediately because required checks/reviews are pending. An already-clean PR should not be sent through the `enable auto-merge` mutation.

After source is complete:

1. Freeze the canonical PR head. No further source correction should be expected.
2. Perform the final exact-head diff/scope review and fresh policy/review/mergeability read.
3. Before merge readiness, require the canonical PR body to contain the exact GitHub closing reference `Closes #<target_issue>` for the frozen FULL target. `Refs #...` is insufficient for FULL completion, and a closing reference to another issue does not satisfy the gate.
4. If the PR is already immediately mergeable and all required gates pass, use **direct squash merge with `expected_head_sha`**.
5. If the exact head is frozen but merge is blocked only by required GitHub checks/reviews that are still pending, and repository-level auto-merge is enabled, native auto-merge may be armed.
6. Never push a new source commit after native auto-merge is armed. If a correction becomes necessary, auto-merge must first be safely disabled; inability or ambiguity in doing so is `STOP_ERROR`.
7. Any head change invalidates all prior merge readiness and requires a fresh final review/check cycle.
8. Never bypass rulesets, force merge, rewrite history or treat merge as production authorization.

Repository-level `Allow auto-merge` is optional for correctness because the direct exact-head path remains valid for already-ready PRs.

The closing reference is part of the FULL completion safety contract, not a convenience. After merge, fresh-read the exact frozen target issue. GitHub must report that issue as `closed` before the run can become `DONE` or controller #499 can return to `IDLE`. If the canonical PR merged but the exact target is still open, preserve evidence and enter `STOP_ERROR`; do not silently declare completion or substitute an unrelated issue close.

## Control production/live boundary

A FULL command is **not live authority** in this repository.

It never authorizes:

- Worker upload, deployment, candidate attachment or promotion;
- production D1 migration or data write;
- Queue mutation/replay/configuration change;
- live `/api/github/merge`, Needs changes, Later or another Control decision action/canary with write effects;
- GitHub App permission or selected-repository changes;
- repository ruleset/branch-protection/settings mutation;
- Cloudflare DNS, Access, Tunnel, domain, binding or infrastructure mutation;
- secret, credential or token changes;
- RPi5/root/sudo/systemd/Docker/network/host mutation;
- destructive cleanup or undeclared retry/rollback/alternate mutation path.

If an issue's Definition of Done ultimately requires one of those actions and there is no separate exact owner live authorization, source work may converge and merge, then the run must stop at `PAUSED_OWNER_LIVE_GATE`. Issue #1, #278 and the focused live tracker remain the authority for that next gate.

## Resume model

Preferred low-latency resume is a ChatGPT Work GitHub event-triggered task reacting to relevant PR activity. It is an optimization, not a correctness requirement.

An hourly Scheduled Task may act as watchdog/fallback and must reconstruct state from GitHub. Standard Scheduled Tasks on paid plans are limited to hourly recurrence; Plus also has a finite active-task quota. Do not create extra watchdog tasks merely because FULL exists—reuse or consolidate task capacity separately.

## Failure model

- Same objective: at most three materially justified attempts; stop before a fourth identical failure loop.
- After any mutation begins, an error, timeout or ambiguous outcome requires read-only evidence preservation and STOP unless recovery was explicitly pre-authorized.
- No automatic rollback, cleanup, force operation or alternate mutation route.
- Usage exhaustion may pause as `PAUSED_USAGE`; platform approval as `PAUSED_PLATFORM_APPROVAL`; external dependency waits as `PAUSED_EXTERNAL`.

## Completion

For source-only issues, `DONE` requires:

- issue Definition of Done satisfied;
- canonical PR contains the exact `Closes #<target_issue>` reference for the frozen FULL target;
- canonical PR merged under the frozen FULL authority;
- exact target issue freshly re-read as `closed` after merge;
- exact new `main` re-read;
- exact-main CI verified when the repository runs CI on push;
- final GitHub receipt recorded;
- controller #499 returned to `IDLE` only after the target-closed check passes.

A merged PR with an open frozen target is `STOP_ERROR`, not `DONE`, and the controller must not be returned to `IDLE` on that basis.

If unapproved strict live work remains necessary, the run is not `DONE`; it is `PAUSED_OWNER_LIVE_GATE`.
