# Credential and token model

Last verified against official Cloudflare and GitHub documentation: 2026-08-13.

This document is the normative credential/token policy for Rozkalns Control. It exists to keep setup simple while preserving explicit trust boundaries and avoiding permanent broad control-plane credentials.

## Principles

- Use one temporary Cloudflare setup token for the Control build-out instead of creating a new API token for every individual Cloudflare step.
- Keep that setup token only while the Cloudflare control plane is being assembled and verified; revoke/delete it when setup is complete.
- Do not reuse the temporary setup token as a permanent runtime credential.
- Create a permanent Cloudflare API token only if a concrete future unattended Cloudflare control-plane automation requires one; scope it only to that implemented automation.
- Worker runtime access to D1 and Queues uses Cloudflare resource bindings, not a Cloudflare API token.
- GitHub runtime access uses the dedicated Rozkalns Control GitHub App and short-lived installation access tokens, not a PAT.
- Secrets belong in Cloudflare Worker secret bindings / purpose-built secret storage, never in repository files, D1 rows, logs, issues, PRs, screenshots or generated evidence.
- Merge authorization is separate from deploy authorization. Credential possession never implies human authorization for a live mutation.

## Temporary Cloudflare setup token

Canonical token name:

`rozkalns-control-setup`

Scope the token to the single Cloudflare account that owns Rozkalns Control resources. Do not grant account-wide unrelated product permissions and do not grant zone permissions unless a future reviewed implementation proves they are required.

The token should contain these account-level permissions:

| Cloudflare Dashboard name | API permission name | Why Control setup needs it |
| --- | --- | --- |
| Workers Scripts → Edit | Workers Scripts Write | Worker version upload/deploy, Worker secret/config operations, custom-domain attachment, subdomain/preview state management, and Worker/Queue consumer control-plane operations supported by the Workers permission. |
| D1 → Edit | D1 Write | Create/select/configure the production D1 database and later apply explicitly authorized remote migrations. |
| Queues → Edit | Queues Write | Create/manage Queue/DLQ resources and allow direct control-plane message smoke tests if a reviewed gate needs them. Some Queue create/consumer endpoints also accept Workers Scripts Write, but the dedicated Queue permission avoids needing another setup token for direct Queue message tests. |
| Access: Apps and Policies → Edit | Access: Apps and Policies Write | Create/update the Cloudflare Access application and its policies for `control.rozkalns.net`. |
| Access: Organizations, Identity Providers, and Groups → Edit | Access: Organizations, Identity Providers, and Groups Write | Initial Zero Trust organization / identity-provider / Access-group setup when required. If the existing account already has the exact required organization and IdP configuration, live gates should verify before mutating it. |

Do **not** add by default:

- DNS Edit;
- Workers Routes Edit;
- Zone Read/Edit;
- Account Settings Edit;
- Billing;
- API Tokens Edit;
- KV/R2/AI/AI Gateway/Turnstile permissions;
- Access Keys Edit;
- Access Service Tokens Edit;
- any other permission merely for future convenience.

### Why no zone permissions are planned

The intended public origin is a Worker Custom Domain for `control.rozkalns.net`. Cloudflare Custom Domains are designed for the Worker to be the origin and Cloudflare creates the required DNS record/certificate. The Custom Domain API accepts Workers Scripts Write. Therefore DNS and Workers Routes permissions are not part of the baseline setup-token contract.

### Lifecycle

1. Create `rozkalns-control-setup` with the exact reviewed permissions above and restrict it to the exact account.
2. Keep the token local to the trusted operator machine; never paste it into chat, GitHub, logs or screenshots.
3. Live scripts receive it through a hidden prompt/environment variable such as `CLOUDFLARE_API_TOKEN`; scripts must not print the value.
4. Every live mutation remains separately owner-authorized even while the token exists.
5. When Cloudflare setup is complete and no further reviewed setup gates need the token, revoke/delete it.
6. Do not leave this broad setup credential on RPi5 or in GitHub Actions secrets.

## Cloudflare runtime credential model

Normal Worker runtime should require **no Cloudflare API token**.

### D1

Production D1 is accessed through the Worker binding `CONTROL_DB`. The binding contains resource identity/configuration, not an API token. Remote database provisioning/migration operations are setup/control-plane actions and use the temporary setup token only while separately authorized.

Planned production database identity:

- database name: `rozkalns-control-production`
- jurisdiction: `eu`
- database UUID: must come from authoritative Cloudflare create/discovery evidence; never invent or placeholder a production UUID.

### Queues / DLQ

Queue producers and consumers should use Worker Queue bindings. Runtime message production/consumption does not require a Cloudflare API token. Queue/DLQ creation and binding are control-plane setup steps and remain separately authorized.

### Cloudflare Access

The human-facing application will use Cloudflare Access. Worker-side authorization must validate the Access JWT cryptographically against the expected issuer/JWKS and application audience. Runtime JWT verification relies on Cloudflare's public verification material and does not require a Cloudflare API token.

## GitHub credential model

### Dedicated GitHub App

Canonical App: `Rozkalns Control`.

The Worker currently requires:

- `GITHUB_APP_PRIVATE_KEY_PEM` — secret binding;
- `GITHUB_APP_CLIENT_ID` — non-secret binding;
- `GITHUB_APP_INSTALLATION_ID` — non-secret binding.

The private key signs GitHub App JWTs. The Worker then obtains short-lived GitHub App installation access tokens on demand. GitHub installation access tokens expire after one hour and may be narrowed to selected repositories/permissions. No GitHub PAT is part of the runtime design.

### Current Phase 2 repository permissions

Steady-state read-only permissions remain:

- Metadata: read;
- Contents: read;
- Issues: read;
- Pull requests: read;
- Checks: read;
- Actions: read.

Commit statuses remain conditional on evidence; Administration remains outside the current contract.

### Future Phase 3 permission additions

These are **GitHub App permission changes**, not additional standalone tokens:

- Merge via `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` requires Contents: write. The request supports `sha`, which must be set to the exact approved PR head so a changed head fails closed.
- Create/submit request-changes reviews requires Pull requests: write.
- Re-run workflow/failed jobs requires Actions: write.

Add each write permission only when the corresponding UI/action and exact pre-mutation revalidation are implemented and separately owner-approved.

## GitHub webhook secret

When webhook delivery is activated, create one high-entropy shared webhook secret and store it as a Worker secret binding (planned name: `GITHUB_WEBHOOK_SECRET`) and in the GitHub App webhook configuration.

The Worker must validate `X-Hub-Signature-256` HMAC-SHA256 over the original/raw request bytes before trusting the payload. `X-GitHub-Delivery` is the durable replay identity. Webhook activation must not happen until the D1 claim path and Queue/DLQ acceptance path are durable and tested.

This secret is independent from the GitHub App private key.

## Optional future credentials

Do not create these until the feature is selected and implemented:

- Telegram notifications: one Telegram Bot token as a Worker secret.
- Web Push: VAPID private key as a secret; VAPID public key is non-secret.
- Unattended Cloudflare control-plane automation: one dedicated permanent Cloudflare API token, but only after a fresh permission audit of the exact implemented API calls. Never keep the broad setup token for this purpose.

## Script policy

### New Cloudflare live scripts

New setup/live gates should use a single input credential:

`CLOUDFLARE_API_TOKEN`

They must still preserve:

- exact authorized source SHA;
- fresh remote-main/CI verification where applicable;
- fail-closed preconditions;
- exact expected resource names/IDs;
- post-write read-back verification;
- no blind retry after an ambiguous successful write;
- sanitized output with no credential values;
- explicit STOP before any separately gated mutation.

Before writing or revising a script that depends on Cloudflare/GitHub/Wrangler behavior, re-check the exact official endpoint/command documentation current at implementation time.

### Historical two-token gates

`scripts/cloudflare-first-version-gate.mjs` and `scripts/cloudflare-second-version-gate.mjs` intentionally required distinct read and write tokens at the time they were authored. That separation was a project hardening choice, not a Cloudflare platform requirement.

Those one-shot gates have already served their purpose and must not be rerun using consumed owner authorizations. Do not rewrite history solely to make those completed gates accept the new setup-token model. The one-token policy applies to new setup/live controllers going forward.

## GitHub Actions / CI

The normal repository CI must not receive the Cloudflare setup token or GitHub App private key. CI remains source validation only unless a future separately reviewed deployment workflow is introduced.

Current CI uses repository `contents: read`, checkout with persisted credentials disabled, and Wrangler dry-run; it does not perform a Cloudflare deploy.

## Credential inventory

| Credential / binding | Secret? | Runtime? | Expected lifetime |
| --- | --- | --- | --- |
| `rozkalns-control-setup` Cloudflare API token | yes | no | temporary; delete after setup |
| `GITHUB_APP_PRIVATE_KEY_PEM` | yes | yes | long-lived key material; rotate deliberately |
| GitHub App installation access token | yes | yes | generated on demand; ~1 hour |
| `GITHUB_APP_CLIENT_ID` | no | yes | stable config |
| `GITHUB_APP_INSTALLATION_ID` | no | yes | stable config |
| `GITHUB_WEBHOOK_SECRET` | yes | yes when webhook enabled | long-lived shared secret; rotate deliberately |
| `CONTROL_DB` D1 binding | no API secret | yes | stable resource binding |
| Queue/DLQ bindings | no API secret | yes | stable resource bindings |
| Cloudflare Access issuer/team domain + application AUD | no private credential | yes | stable auth configuration |
| permanent Cloudflare API token | yes | only if future automation proves necessary | not currently required |

## Official references checked

Cloudflare:

- https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/
- https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/
- https://developers.cloudflare.com/api/resources/queues/methods/create/
- https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/create/
- https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/create/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/

GitHub:

- https://docs.github.com/en/rest/apps/apps
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- https://docs.github.com/en/rest/pulls/pulls
- https://docs.github.com/en/rest/pulls/reviews
- https://docs.github.com/en/rest/actions/workflow-runs
- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

## Current live boundary

This document does not itself authorize any live mutation. Creating D1, applying migrations, creating Queues/DLQ, changing Worker bindings, creating Access resources, changing GitHub App permissions, enabling webhooks, attaching `control.rozkalns.net`, deploying a Worker version to traffic, or revoking credentials each remains subject to the project's explicit owner gates.
