# Phase 2 async Promise safety

Issue: #23  
PR: #25

## Purpose

Before Rozkalns Control adds live webhook, D1, Queue producer/consumer or reconciliation handlers, production TypeScript must fail CI when it drops Promise work unintentionally.

## Current source-only contract

`eslint.config.js` enables type-aware linting for `src/**/*.{ts,tsx}` using `parserOptions.projectService: true` and enables:

```text
@typescript-eslint/no-floating-promises = error
```

The rule is intentionally scoped to production source rather than `tests/**/*.ts`. Node's `node:test` top-level `test(...)` registration API is Promise-valued and produced false-positive noise for this runtime-safety goal when the rule was applied to all tests. Test files continue to receive the existing non-type-checked recommended lint rules.

The configuration itself is regression-locked by `tests/eslint-config.test.ts`.

## Runtime handling rule

For production Worker/shared/UI code, a Promise must be handled deliberately:

- `await` work required before the current operation is correct;
- `return` a Promise when the caller owns completion;
- use Worker `ctx.waitUntil()` for explicitly post-response work that is allowed to finish after the response;
- use `void` only when intentionally discarding the result is semantically safe and rejection behavior is separately understood/handled.

Do not add blanket lint disables or broad safe-call allow-lists to make async code pass.

## Evidence from enablement

The first typed-lint CI attempt correctly failed because test files were outside a `tsconfig.json` Project Service project. A follow-up project file made the rule apply to tests and exposed 58 top-level `node:test` registration calls, confirming that the rule was active but too broadly scoped for the production runtime objective.

The final source scope protects `src/` only and passes existing production code without suppressions.

## Still not live

This contract does not add:

- webhook routes;
- D1 databases or bindings;
- Queue/DLQ resources or bindings;
- Queue producer/consumer handlers;
- Cloudflare deploys;
- GitHub App permissions or installation changes;
- RPi5/DB/host mutations;
- AI execution.

`DEPLOY_REQUIRED=no`.
