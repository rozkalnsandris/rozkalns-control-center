# Cloudflare deploy standardization v1

This repository remains a Cloudflare-native Worker + Static Assets application. This contract standardizes release identity, evidence and deploy-impact classification without moving production to RPi5, Docker or SIMPLE-DEPLOY.

Machine-readable policy: `.github/cloudflare-deploy-standardization-v1.json`.
Deterministic classifier: `tools/cloudflare-deploy-standardization.mjs`.
Production executor: `.github/workflows/production-worker-composite-live.yml`.

## Source gate

A deploy-eligible source state is bound to one exact reviewed Git SHA. The exact SHA must have successful repository CI evidence, including the normal build/test path and Wrangler dry run. Unknown, stale or mismatched source/CI evidence fails closed.

Merge is source acceptance only. Merge never grants Worker publication, D1/Queue mutation, credential access, Cloudflare infrastructure mutation or any RPi5 authority.

## Deploy-impact classes

The classifier accepts changed repository paths and returns the highest-risk applicable class:

```text
node tools/cloudflare-deploy-standardization.mjs <changed-path>...
```

### `SOURCE_ONLY`

Documentation-only paths that do not alter the Worker/Static Assets artifact or a live-control boundary. No production publication is implied.

### `ORDINARY_PUBLICATION`

Worker/frontend/build inputs such as `src/`, `public/`, package lockfiles and build configuration. These changes can require a Worker + Static Assets publication after merge, but publication remains a separate exact owner-authorized production action.

### `STRICT_LIVE`

Cloudflare configuration, workflows/control-plane source, migrations, scripts/tools, or any unknown path. This class fails closed and requires a separate exact owner decision for any production mutation. D1 schema/data apply, Queue/DLQ mutation, Access/DNS/Tunnel/network/account changes, credential/secret mutation and GitHub App permission expansion are always separate strict-live concerns.

Risk precedence is:

```text
STRICT_LIVE > ORDINARY_PUBLICATION > SOURCE_ONLY
```

An empty or unknown diff is `STRICT_LIVE`.

## Ordinary Worker + Static Assets publication

The accepted production workflow already implements the platform-native release sequence:

```text
source/tests/PR/review
-> merge
-> exact main SHA + successful exact-main CI
-> separate exact owner Composite Live authorization
-> checkout exact approved SHA
-> re-run source validation
-> confirm current Worker deployment/version baseline
-> revalidate exact main SHA
-> wrangler versions upload
-> attach candidate at 0% traffic
-> exact candidate /api/health smoke via version override
-> revalidate deployment + main SHA before promotion
-> promote the verified candidate to 100%
-> read-only deployment reconciliation + /api/health verification
-> bounded receipt
```

`wrangler versions upload` is intentionally used to create the candidate without immediately promoting production traffic. `wrangler versions deploy` is the separate traffic/deployment step. Static Assets remain bundled with the Worker according to `wrangler.jsonc`; this contract does not create a second publication system.

After the first production mutation begins, ambiguity or failure stops the operation. There is no implicit retry, rollback, cleanup or alternate mutation path.

## Explicit exclusions

This source-standardization contract does not authorize or perform:

- production Worker or Static Assets publication;
- D1 schema/data migration or remote apply;
- Queue or DLQ mutation;
- Cloudflare Access, DNS, Tunnel, network or account-setting changes;
- credential/secret creation, rotation, export or binding mutation;
- GitHub App permission or repository-selection expansion;
- RPi5 target/allowlist, Docker, systemd, host or runtime mutation.

Those actions remain under their existing exact owner gates and trust boundaries.

## CI invariant

Repository CI executes `tools/cloudflare-deploy-standardization.test.mjs`. The test keeps the machine policy, path classifier, Wrangler architecture and the existing production workflow invariants synchronized. Unknown drift fails CI rather than silently weakening the deploy boundary.
