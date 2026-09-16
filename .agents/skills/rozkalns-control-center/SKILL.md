---
name: rozkalns-control-center
description: Use for repository-specific work in rozkalnsandris/rozkalns-control-center: React/TypeScript/Vite UI, Cloudflare Worker/D1/Queues, GitHub App integration, fail-closed decision flows, AUTO-RUN FULL routing, CI/review convergence, and deploy-gate preparation. This skill never grants merge, permission expansion, or production/LIVE authority.
---

# rozkalns-control-center workflow

Follow repository `AGENTS.md` and master issue `#1` first. This skill is an execution aid only; it must not become a second authority system.

## 1. Resolve the current authority and phase

1. Read issue `#1`, `AGENTS.md`, and `.github/start-mode-routing.json`.
2. Identify the current phase/exit criterion and exact current task.
3. Refresh current `main` and only the issue/PR/CI/review/continuation state needed for that task.
4. Do not infer `GITHUB-ONLY`, `LIVE-ALL`, or `AUTO-RUN FULL` from chat history, controller state, prior receipts, issue names, or deploy queues.
5. For explicit `AUTO-RUN FULL rozkalns-control-center #<issue>`, read `.github/auto-run-full-v2.json`, `docs/AUTO_RUN_FULL_V2.md`, the exact issue/DoD, required continuation/controller state, and current relevant PR/CI/review state before activation work.
6. Treat GitHub as canonical for mutable source, issue, PR, review, check, and SHA state.

This skill never creates merge, LIVE, retry, rollback, cleanup, credential, permission, D1/Queue production-write, Cloudflare, or RPi5 authority.

## 2. Preserve product and trust-boundary invariants

- GitHub remains the canonical engineering source of truth.
- React components consume normalized models rather than raw GitHub payloads.
- Re-resolve authoritative GitHub state immediately before protected mutations.
- Fail closed on stale, partial, unsupported, or unrequested evidence.
- Bind protected human decisions to exact expected/current PR head SHA where the product contract requires it.
- Merge is not deploy authority.
- Do not introduce direct SSH/sudo/root paths from Control to RPi5.
- Least privilege applies to the dedicated Rozkalns Control GitHub App; do not broaden permissions for future convenience.
- Secrets belong in approved secret bindings, never source, D1, logs, fixtures, screenshots, or issue/PR text.
- Verify GitHub webhook HMAC over raw request bytes before payload trust, and cryptographically validate Cloudflare Access identity where required.

## 3. Work with the actual project stack

Baseline project stack is React + TypeScript + Vite on Cloudflare Workers/Static Assets with repository-managed Wrangler, D1/Queues, and GitHub integrations.

- Use the project's pinned Node/Wrangler/toolchain versions and existing package scripts.
- Prefer generated binding/runtime types over hand-written platform types.
- Keep environment/config changes minimal and preserve existing deployment conventions.
- For Worker source/config review, use the installed `workers-best-practices` skill when available; it supplements, never overrides, repository rules.
- For Wrangler command/config work, retrieve current Cloudflare documentation and local help/schema rather than relying on memorized flags.
- For UI flows, use Playwright when available to verify visible actions, focus/mobile behavior, browser console/network state, and regression scenarios.

Do not run production deployment, remote D1 mutation, Queue mutation, Access/DNS/Tunnel changes, GitHub App permission/repository-selection changes, or other live Cloudflare operations without the exact separate authority required by `AGENTS.md` and issue `#1`.

## 4. Implement minimally and verify in layers

1. State the verified problem or acceptance target in one sentence.
2. Read the smallest set of source/tests/contracts that own the behavior.
3. Change only that boundary; avoid opportunistic architecture, permission, automation, or UI expansion.
4. Add focused regression coverage for stale-state, replay/idempotency, authorization, or fail-closed behavior when security-sensitive logic is touched.
5. Run the narrowest relevant checks first, then required typecheck/lint/unit/build/security checks from the repository scripts.
6. Inspect the final diff for unrelated files, generated output, secrets, unsafe capability expansion, and deploy impact.

For source-only changes, do not claim production success from local tests or source inspection. Distinguish source readiness, deploy readiness, and live verification.

## 5. Verify external platform semantics when they matter

Cloudflare, GitHub, ChatGPT/Codex, Android/browser, and related platform contracts change. Before implementing behavior that depends on current APIs, permissions, limits, deployment semantics, auth, or UI behavior, retrieve current authoritative documentation.

## 6. Respect the active GitHub lane

- FAST may carry safe source/docs/tests/policy work through focused branch/commit/push, Draft PR, CI/review convergence, and Ready when the repository contract permits it.
- Stage exact intended paths only; never use broad staging.
- FAST merge remains an explicit owner decision.
- FULL exists only after exact issue-scoped activation and a valid frozen authorization receipt.
- FULL source/merge authority does not imply Worker deployment, D1/Queue mutation, GitHub App permission expansion, Cloudflare infrastructure mutation, secrets/credentials, or RPi5 runtime authority.
- Do not bypass rulesets, force-push, rewrite history, or invent retry/rollback/cleanup authority after a failed mutation.

## 7. Report compactly with evidence

Return:

- problem/root cause or acceptance target;
- exact files changed;
- checks/tests and exact results;
- security/permission/deploy impact;
- source versus live evidence boundary;
- remaining uncertainty/blocker;
- the single next action/command required by the current repository work-cycle contract.
