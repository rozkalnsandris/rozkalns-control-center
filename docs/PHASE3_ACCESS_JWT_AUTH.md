# Phase 3 — Cloudflare Access JWT authentication boundary

Issues: #163, #165, #167, #169, #171, #173, #386

## Purpose

Phase 3 may eventually expose authenticated human decision actions such as Merge / Needs changes / Later. Before any such side effect exists, the Worker must independently prove the Cloudflare Access application JWT rather than trusting that a request merely passed through Access or contains an authentication-looking header.

The Phase 3 authentication foundation is deliberately split into reviewed slices:

- #163/#164 introduced the cryptographic JWT verifier;
- #165/#166 added the bounded Access signing-key transport/cache/rotation resolver;
- #167/#168 composed those two pieces into one Worker-side request-authentication boundary;
- #169/#170 added a dedicated read-only authentication canary route adapter;
- #171/#172 wired that canary into the Worker behind an explicit fail-closed runtime resolver while deliberately leaving all live Access configuration absent;
- #173 prepares the separately owner-gated production Access auth canary activation gate without performing the activation or deployment;
- #386 extends the already-cryptographic verifier with an explicit, bounded Cloudflare service-token application-JWT claim path required by machine canaries, while preserving the strict interactive identity path.

None of these source-review slices adds GitHub write permission, changes Cloudflare Access policy, performs a production Access canary, or deploys production code.

## External contract rechecked 2026-08-24

Current Cloudflare Access documentation describes the application token in the `Cf-Access-Jwt-Assertion` request header and requires origins/Workers that make authorization decisions to validate the JWT. Access application tokens are RS256 signed and are bound to the Access issuer/team domain plus the application audience. Cloudflare recommends validating the request header rather than relying on the browser cookie.

Cloudflare publishes account signing keys at:

`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`

The application therefore must validate the signed token against the expected team-domain issuer and exact application audience, and must resolve the JWT `kid` from the bounded rotating signing-key set rather than pinning one public key indefinitely.

Cloudflare's current application-token documentation also distinguishes two application-JWT payload forms after successful Access authentication:

- identity-provider authentication uses a non-empty `sub`, includes `nbf`, and may include an asserted `email`;
- service-token authentication still uses `type="app"`, uses an empty `sub`, identifies the non-secret service-token Client ID in `common_name`, and the documented service-token payload does not require `nbf`.

The verifier therefore treats these as two explicit, mutually exclusive claim forms after signature verification. The service-token form does not weaken signature, key, issuer, audience, expiration or issued-at validation. When `nbf` is present on a service-token JWT it is validated with the same safe-integer and not-before semantics as the interactive form.

Cloudflare Wrangler also supports deploy-time `--var key:value` injection. #173 uses that only as a future APPLY mechanism so the discovered non-secret issuer/AUD/enable values do not need to be committed to `wrangler.jsonc` during source preparation. Secrets/tokens remain environment-only and are never passed as deploy arguments.

## Verification contract

`CloudflareAccessJwtVerifier`:

1. reads only `Cf-Access-Jwt-Assertion` for request authentication; no cookie fallback is accepted;
2. requires exactly three compact JWT segments within fixed size bounds;
3. parses only the JOSE header before cryptographic verification and requires `alg=RS256` plus a bounded non-empty `kid`;
4. resolves a signing JWK only by that validated `kid`;
5. accepts only RSA signing-key evidence compatible with RS256 verification;
6. verifies the signature over the exact encoded `header.payload` bytes;
7. only after signature success parses and validates claims;
8. requires application token `type=app`, exact configured issuer, exact configured audience membership, coherent integer `exp`/`iat`, and current validity for every accepted claim form;
9. for the interactive identity form, requires a bounded non-empty `sub`, requires an integer `nbf`, permits only a bounded syntactically email-like optional `email`, and rejects `common_name` as an ambiguous mixed form;
10. for the service-token form, requires `sub` to be exactly the documented empty string, requires a bounded non-empty `common_name`, rejects identity-only `email`/`identity_nonce` evidence, and treats `nbf` as optional but enforces it when present;
11. derives a bounded audit principal as `service-token:<common_name>` for the service-token form, while preserving the exact interactive `sub` for the identity form;
12. returns only `{ subject, email }` and never returns or logs the raw JWT, signature, key material or service-token secret.

Expected issuer configuration is restricted to an HTTPS `*.cloudflareaccess.com` origin with no credentials/path/query/fragment. The application audience is an opaque bounded identifier supplied only as trusted configuration. `common_name` is treated only as the documented non-secret service-token Client ID and is never accepted as a credential or used to select an issuer, audience, signing key, network destination or authorization target.

## JWKS resolver contract

`CloudflareAccessJwksResolver`:

1. accepts only the validated team issuer as configuration and deterministically derives exactly one `/cdn-cgi/access/certs` URL;
2. never lets a JWT header, `kid`, request URL or other caller-controlled value select a network origin/path;
3. performs only a `GET` for the fixed certs endpoint, with redirects rejected and a bounded request timeout;
4. bounds declared and streamed response size before JSON admission;
5. accepts only a small non-empty `keys` array with unique bounded `kid` values and RSA / RS256 / signing-use evidence;
6. strips unrelated JWK response fields before caching and returns cloned key material to callers;
7. keeps current+previous keys in an in-memory cache for a short bounded TTL;
8. serves a known `kid` directly from a fresh cache without network I/O;
9. on a fresh-cache `kid` miss, performs one immediate refresh so a newly rotated signing key can be discovered;
10. coalesces concurrent refreshes into one fetch;
11. replaces the cache only after an entire newly fetched key set passes validation;
12. fails closed for network/timeout, redirect/non-2xx, oversized/malformed response, unsafe/duplicate keys and still-unknown `kid`.

The cache is isolate-memory optimization only. It is not durable state, does not contain Access JWTs or private key material, and correctness never depends on cache persistence across Worker isolates.

## Composed Worker request-authentication boundary

`CloudflareAccessRequestAuthenticator` is the single entry point intended for later Worker action routes and machine canaries. It composes the merged resolver and verifier under one explicit configuration contract:

1. one trusted `issuer` value is passed to both the JWKS resolver and JWT verifier;
2. the exact Access application `audience` is supplied only as trusted config and is never inferred from request/token data;
3. the resolver remains the only component allowed to fetch signing keys and still derives exactly one fixed team-domain certs endpoint;
4. request authentication still delegates exclusively to `CloudflareAccessJwtVerifier.verifyRequest`, so only `Cf-Access-Jwt-Assertion` is authoritative and there is no `CF_Authorization` cookie fallback;
5. the authenticated result is copied into the bounded `{ subject, email }` principal projection only; interactive identities retain their bounded subject/email projection, while service-token identities receive only the bounded `service-token:<common_name>` subject and `email: null`;
6. every request-time verifier/JWKS/network/rotation failure is collapsed at this outer boundary to the stable `ACCESS_AUTHENTICATION_FAILED` error;
7. underlying JWT/JWKS error codes, raw tokens, signatures, key material and transport details are not propagated through the outer request-authentication error;
8. fetch and clock dependencies remain injectable so deterministic tests can exercise real RSA signatures and synthetic JWKS rotation without live network access.

The stable outer error is deliberate: HTTP routes can return one generic authentication denial without exposing whether a request failed due to missing JWT, bad signature, issuer/audience mismatch, unknown `kid`, JWKS refresh, timeout or malformed key evidence.

## Read-only authentication canary route

`handleAccessAuthCanaryRequest` provides the route adapter intended for the first real Worker-side authentication proof. Its contract is deliberately narrower than the authenticator itself:

1. exact path `/api/auth/access-canary` only;
2. `GET` only, no query parameters, and every response uses `Cache-Control: no-store`;
3. the only dependency is an injected request authenticator;
4. absent runtime/authenticator state fails closed as `503 ACCESS_AUTH_CANARY_DISABLED`;
5. any authentication/JWKS/network failure is reduced to `403 ACCESS_AUTHENTICATION_FAILED`;
6. successful authentication returns only `{ "status": "AUTHENTICATED" }`;
7. the route never returns principal subject, email, JWT, `kid`, JWK, issuer, audience, network detail or inner failure reason;
8. the adapter has no GitHub, D1, Queue or mutation dependency.

## Fail-closed canary runtime wiring

`resolveAccessAuthCanaryRuntime` is the bridge between Worker bindings and the already-reviewed authenticator:

1. the canary is disabled unless `CONTROL_ACCESS_AUTH_CANARY_ENABLED` is exactly the string `true`;
2. disabled mode does not require or interpret issuer/AUD configuration and returns no authenticator;
3. enabled mode requires bounded non-empty `CONTROL_ACCESS_ISSUER` and `CONTROL_ACCESS_AUDIENCE` strings with no surrounding whitespace;
4. the existing `CloudflareAccessRequestAuthenticator` remains responsible for validating issuer/audience semantics and constructing the bounded JWKS/verifier stack;
5. missing, malformed or rejected configuration collapses to `INVALID_CONFIGURATION` with no authenticator and no inner error detail;
6. `src/worker/index.ts` dispatches the exact canary path and passes the route adapter either the READY authenticator or `null`;
7. `wrangler.jsonc` still intentionally contains none of `CONTROL_ACCESS_AUTH_CANARY_ENABLED`, `CONTROL_ACCESS_ISSUER`, or `CONTROL_ACCESS_AUDIENCE` in #173.

Therefore the merged source remains fail-closed until a separately reviewed live gate supplies exact runtime values and deploys them.

## Production Access auth canary activation gate

`cloudflare-access-auth-canary-gate.mjs` prepares the first production proof while preserving a strict PLAN/APPLY split.

### PLAN

PLAN is mutation-free. It requires a clean local `main` at the exact expected SHA, successful exact-main push CI, the reviewed Wrangler pin/source configuration, temporary Cloudflare API credentials supplied only in the environment, and a short-lived Control Access application token supplied only as `CONTROL_ACCESS_TOKEN`.

PLAN then proves:

1. the exact currently active Worker version/deployment and Custom Domain;
2. workers.dev and Preview URLs remain disabled;
3. the current live Worker still has exactly the reviewed pre-activation plain-text bindings plus the required D1/private-key/webhook-secret bindings;
4. the reviewed reconciliation Queue/DLQ topology and consumer settings still exist under the same opaque identities;
5. exactly one parent self-hosted Access application owns the exact `control.rozkalns.net` public destination;
6. the short-lived Access token contains that exact parent application AUD;
7. the token issuer is an exact `https://<team>.cloudflareaccess.com` origin;
8. the token's RS256 signature verifies against the matching `kid` from that issuer's fixed `/cdn-cgi/access/certs` JWKS;
9. protected health still passes while the canary is still either absent (`404`) or disabled fail-closed (`503`).

Only after those checks does PLAN print one exact `OWNER_AUTHORIZATION` string binding SHA, CI run, current version/deployment/domain, parent Access application id/AUD, verified issuer, Queue/DLQ ids and the `inactive` precondition.

### APPLY

APPLY is not authorized by merging #173 or by `turpini`. It requires a **separate explicit owner authorization** that exactly matches the current PLAN output. Before any write it repeats the complete source, GitHub CI and production-state proof, runs the full repository check under a sanitized environment, then repeats the live prewrite state proof again.

If and only if every value is still exact, APPLY may execute one `wrangler deploy --strict` with all existing reviewed non-secret vars plus:

- `CONTROL_ACCESS_AUTH_CANARY_ENABLED=true`;
- `CONTROL_ACCESS_ISSUER=<exact verified issuer>`;
- `CONTROL_ACCESS_AUDIENCE=<exact parent Access AUD>`.

The Cloudflare API token remains in the child process environment. The short-lived Access token and owner authorization are explicitly removed from the Wrangler child environment and are never placed on argv. No Access app/policy write API exists in this gate.

Once `DEPLOY_STARTED=YES` is emitted, the authorization is consumed. Any later failure requires reconciliation; blind retry is forbidden.

Post-deploy verification requires a new active Worker version/deployment, exact activated bindings, unchanged domain/subdomain/Queue/Access-app identities, protected health PASS, and a real Access-authenticated canary response exactly equal to `{ "status": "AUTHENTICATED" }`. Requests with missing or forged public Access credentials must not produce a 2xx canary success. Worker-side missing/forged JWT handling remains independently covered by deterministic source tests.

## End-to-end source tests

The authentication composition tests use generated RSA keypairs and real RS256 signatures together with mocked team-domain JWKS responses. They prove:

- valid current-key interactive identity authentication;
- documented service-token application-JWT authentication with `sub=""`, bounded `common_name` and no mandatory `nbf`;
- service-token `nbf` validation when the claim is present;
- rejection of malformed or mixed interactive/service-token claim forms;
- current + previous signing-key acceptance from one cached set;
- refresh-on-`kid`-miss for a newly rotated key;
- exact fixed certs URL derivation;
- no cookie fallback;
- forged signature rejection;
- wrong issuer and audience rejection after signature verification for both claim forms;
- JWKS network and unknown-key failures collapsing to one outer auth error;
- principal/error objects do not contain raw token/JWK/network detail or service-token secret material.

The canary-route tests additionally prove exact path/method/query handling, disabled fail-closed behavior, generic 403 authentication failure, non-identity success output and absence of inner-auth or principal leakage.

The runtime tests prove exact-string enable semantics, disabled behavior, missing/malformed configuration rejection and READY construction through the reviewed `CloudflareAccessRequestAuthenticator`. #173 adds source-boundary regression coverage for the mutation-free PLAN contract, cryptographically bound issuer/AUD discovery, one strict APPLY deployment boundary, environment-only credentials, no Access/D1/Queue/GitHub mutation transport, and continued absence of live Access canary values from `wrangler.jsonc`.

## Explicitly not activated by #386

This source-only compatibility change does not add or perform:

- a production Worker deployment;
- an Access application or policy mutation;
- any Access service-token creation, rotation or secret exposure;
- a GitHub review mutation or another #247 production canary attempt;
- GitHub App permission or repository-selection expansion;
- D1 production write/migration;
- Queue production write/topology mutation;
- Merge / Needs changes / Later UI activation;
- RPi5/host/root mutation.

Because #386 changes Worker authentication behavior, a future production rollout is required after merge. Merge authorization does not authorize that rollout.

## Next activation prerequisites

After #386 is merged and exact-main CI is green, the next step is a separately owner-gated production Worker rollout using the current deployment contract. Only after that rollout succeeds may the #247 path run a fresh post-deploy GET-only reconciliation.

Before any actual GitHub side effect is attempted again, the system must still:

- prove the newly deployed service-token JWT path under a fresh read-only reconciliation;
- re-read authoritative GitHub target state and exact target CI immediately before the side effect;
- bind a new non-replayable request ID and fresh expected SHA/action target;
- prove the durable D1 request ID is absent before the mutation;
- obtain a new explicit owner `REQUEST_CHANGES` authorization;
- preserve idempotency and durable audit evidence;
- never retry the consumed prior #247 authorization/request ID;
- keep merge authorization separate from deployment and side-effect authorization.

**Production deploy: YES after merge, under a separate owner gate.**
