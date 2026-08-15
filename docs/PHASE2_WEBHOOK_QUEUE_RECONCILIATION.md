# Phase 2 — webhook / Queue partial-activation reconciliation

Issues: #157, #160

## Why this gate exists

The first live webhook/Queue activation crossed `WRITE_STARTED=YES`, created the reviewed main Queue and DLQ, deployed the webhook-enabled Worker, and then stopped during post-verification because Cloudflare returned `script_name: null` for Queue consumers.

The consumed authorization from #157 must never be reused. The initial activation gate must never be replayed against this partially written state.

## Proven partial production state

The read-only reconciliation snapshot after the stop proved:

- active Worker version `95ac62dd-c266-4f27-97f5-2e4eef77466a` at 100% via deployment `3fefdf33-fe33-409c-a4aa-dd8154e9eb9a`;
- main Queue `rozkalns-control-reconciliation`, ID `31cf71912525401fa2a322b18fca26b2`;
- main Worker consumer ID `f33e736438b543c18dc7b58bb5eb126a`;
- DLQ `rozkalns-control-reconciliation-dlq`, ID `4709d6ab73924fbdb3801610bbe5f384`;
- DLQ Worker consumer ID `8672bcac4e214617bd404ba1a049c30e`;
- main Queue producer `type=worker`, `script=rozkalns-control`;
- exact batch/retry/concurrency/DLQ policy on both consumers;
- `script_name` omitted/null on both consumer responses;
- D1 `webhook_deliveries` count 0;
- `/api/health` healthy;
- `/api/github/webhook-deliveries` healthy/no-store with total 0;
- exact webhook Access application absent.

These values are evidence from that snapshot, not permanent constants. A fresh reconciliation PLAN must rediscover and bind the current state before any continuation write.

## Cloudflare Queue consumer identity rule

Cloudflare's Queue consumer response model documents `script_name` as optional. The reconciliation verifier therefore treats it as optional attestation:

- if `script_name` is present and non-null, it must equal `rozkalns-control`;
- if it is omitted/null, the verifier still requires exactly one Worker consumer on the exact Queue, exact queue name, consumer ID, batch/retry/concurrency/dead-letter settings, reviewed source configuration, active reviewed Worker version, and the documented main Queue producer identity `producers[].script = rozkalns-control`;
- a conflicting non-empty `script_name` fails closed;
- duplicate consumers fail closed.

The DLQ has no producer and must remain producer-free.

## Dedicated reconciliation gate

Script:

`node scripts/cloudflare-webhook-queue-reconciliation-gate.mjs`

Modes:

- `--mode plan` — read-only;
- `--mode apply` — Access-only continuation after a fresh exact owner authorization.

The gate intentionally contains no Queue-create operation and no Worker deploy operation.

## PLAN

PLAN requires:

- exact current repository `main` SHA;
- exact successful `main` push CI run;
- temporary Cloudflare API token with the required read permissions;
- short-lived `CONTROL_ACCESS_TOKEN` for the parent Access application.

PLAN verifies:

- clean exact-main checkout and exact-main CI;
- full `npm run check`;
- reviewed Wrangler source contract;
- active webhook-enabled Worker version/deployment;
- custom domain and disabled workers.dev/Preview URLs;
- parent Access app by the validated Access application audience (`aud`);
- exact main Queue/DLQ identities and unique Worker consumers;
- exact producer/consumer settings while tolerating only an omitted/null `script_name`;
- exact D1 delivery schema and current count;
- protected health and observability;
- absence of the exact webhook Access app or reserved-name collision.

PLAN prints an exact `OWNER_AUTHORIZATION` bound to:

- source SHA and CI run;
- active version/deployment;
- domain ID;
- parent Access app ID and audience;
- main Queue and consumer IDs;
- DLQ and consumer IDs;
- D1 delivery count;
- `webhook absent` state.

PLAN performs no Cloudflare mutation.

## APPLY prewrite

APPLY requires the exact PLAN values plus:

- byte-for-byte `CONTROL_OWNER_AUTHORIZATION`;
- the already-saved `CONTROL_GITHUB_WEBHOOK_SECRET` used by the deployed Worker;
- temporary Cloudflare API token;
- short-lived Access token.

Before any write, APPLY performs the complete state verification twice and additionally sends an HMAC-signed GitHub `ping` through the existing parent Access application using `cf-access-token`.

The ping is side-effect-free by the reviewed runtime contract. It proves before the write boundary that the saved webhook secret matches the already-deployed Worker secret. D1 and observability totals must remain unchanged.

Only after all prewrite checks pass does the gate print:

- `WRITE_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- `NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES`.

## APPLY write scope

The reconciliation write scope is exactly:

1. create self-hosted Access app `Rozkalns Control GitHub webhook` for exact public destination `control.rozkalns.net/api/github/webhook`;
2. create one application-local `Bypass` / `Everyone` policy named `Bypass GitHub webhook HMAC endpoint`.

Forbidden in reconciliation APPLY:

- Queue creation;
- Queue consumer mutation;
- Worker deploy/version creation;
- Worker secret write;
- D1 write;
- parent Access application mutation;
- custom-domain mutation;
- workers.dev/Preview enablement;
- GitHub App permission growth;
- GitHub App settings mutation.

## Post-write verification

After Access creation the gate must prove:

- exact webhook Access app ID/name/type/destination and app-launcher disabled;
- exact single bypass policy;
- unchanged parent Access audience and app ID;
- unchanged active Worker version/deployment;
- unchanged Queue/DLQ and consumer IDs/settings;
- exact public HMAC-signed ping returns `200 {"status":"PING"}` with no-store;
- protected health remains healthy;
- observability remains healthy/no-store;
- D1 delivery total remains the authorized baseline because ping is side-effect-free.

If anything fails after `WRITE_STARTED=YES`, do not rerun. Record the new state and create a new reconciliation plan/authorization.

## Final GitHub App step

Only after the reconciliation gate passes should the GitHub App webhook settings be configured manually with:

- URL: `https://control.rozkalns.net/api/github/webhook`;
- the same saved webhook secret;
- events: `check_run`, `issues`, `pull_request`, `pull_request_review`, `pull_request_review_thread`, `push`, `workflow_run`.

No GitHub permission growth is part of this activation.