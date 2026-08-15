# Phase 3 — Cloudflare Access JWT authentication boundary

Issues: #163, #165, #167

## Purpose

Phase 3 may eventually expose authenticated human decision actions such as Merge / Needs changes / Later. Before any such side effect exists, the Worker must independently prove the Cloudflare Access application JWT rather than trusting that a request merely passed through Access or contains an authentication-looking header.

The Phase 3 authentication foundation is deliberately split into reviewed source-only slices:

- #163/#164 introduced the cryptographic JWT verifier;
- #165/#166 added the bounded Access signing-key transport/cache/rotation resolver;
- #167 composes those two pieces into one Worker-side request-authentication boundary, while still leaving that boundary disconnected from all live routes.

None of these slices adds GitHub write permission, changes Cloudflare configuration, adds a production Worker binding, performs a production JWKS canary, or deploys production code.

## External contract rechecked 2026-08-15

Current Cloudflare Access documentation describes the application token in the `Cf-Access-Jwt-Assertion` request header and requires origins/Workers that make authorization decisions to validate the JWT. Access application tokens are RS256 signed and are bound to the Access issuer/team domain plus the application audience.

Cloudflare publishes account signing keys at:

`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`

The application therefore must validate the signed token against the expected team-domain issuer and exact application audience, and must resolve the JWT `kid` from the bounded rotating signing-key set rather than pinning one public key indefinitely.

## Verification contract

`CloudflareAccessJwtVerifier`:

1. reads only `Cf-Access-Jwt-Assertion` for request authentication; no cookie fallback is accepted;
2. requires exactly three compact JWT segments within fixed size bounds;
3. parses only the JOSE header before cryptographic verification and requires `alg=RS256` plus a bounded non-empty `kid`;
4. resolves a signing JWK only by that validated `kid`;
5. accepts only RSA signing-key evidence compatible with RS256 verification;
6. verifies the signature over the exact encoded `header.payload` bytes;
7. only after signature success parses and validates claims;
8. requires application token `type=app`, exact configured issuer, exact configured audience membership, coherent integer `exp`/`iat`/`nbf`, and current validity;
9. requires a non-empty bounded `sub`;
10. returns only `{ subject, email }`, with email optional, and never returns or logs the raw JWT, signature or key material.

Expected issuer configuration is restricted to an HTTPS `*.cloudflareaccess.com` origin with no credentials/path/query/fragment. The application audience is an opaque bounded identifier supplied only as trusted configuration.

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

`CloudflareAccessRequestAuthenticator` is the first single entry point intended for later Worker side-effect routes. It composes the merged resolver and verifier under one explicit configuration contract:

1. one trusted `issuer` value is passed to both the JWKS resolver and JWT verifier;
2. the exact Access application `audience` is supplied only as trusted config and is never inferred from request/token data;
3. the resolver remains the only component allowed to fetch signing keys and still derives exactly one fixed team-domain certs endpoint;
4. request authentication still delegates exclusively to `CloudflareAccessJwtVerifier.verifyRequest`, so only `Cf-Access-Jwt-Assertion` is authoritative and there is no `CF_Authorization` cookie fallback;
5. the authenticated result is copied into the bounded `{ subject, email }` principal projection only;
6. every request-time verifier/JWKS/network/rotation failure is collapsed at this outer boundary to the stable `ACCESS_AUTHENTICATION_FAILED` error;
7. underlying JWT/JWKS error codes, raw tokens, signatures, key material and transport details are not propagated through the outer request-authentication error;
8. fetch and clock dependencies remain injectable so deterministic tests can exercise real RSA signatures and synthetic JWKS rotation without live network access.

The stable outer error is deliberate: future HTTP routes should be able to return one generic authentication denial without exposing whether a request failed due to missing JWT, bad signature, issuer/audience mismatch, unknown `kid`, JWKS refresh, timeout or malformed key evidence.

## End-to-end source tests

The composition tests use generated RSA keypairs and real RS256 signatures together with mocked team-domain JWKS responses. They prove:

- valid current-key authentication;
- current + previous signing-key acceptance from one cached set;
- refresh-on-`kid`-miss for a newly rotated key;
- exact fixed certs URL derivation;
- no cookie fallback;
- forged signature rejection;
- wrong issuer and audience rejection after signature verification;
- JWKS network and unknown-key failures collapsing to one outer auth error;
- principal/error objects do not contain raw token/JWK/network detail.

A separate source-boundary regression proves this composition is not imported by `src/worker/index.ts` and that `wrangler.jsonc` still has no Access issuer/audience binding in this slice.

## Explicitly not activated

These source-only slices do not add:

- a mutation HTTP route;
- Merge / Needs changes / Later behavior;
- GitHub write permission or write transport;
- live route wiring to the Access authenticator;
- new Worker Access issuer/audience environment variables or secrets;
- a production JWKS fetch/canary;
- new Cloudflare Access application/policy state;
- D1 production write/migration;
- production deployment;
- RPi5/host/root mutation.

## Next activation prerequisites

The next Phase 3 unit may introduce a dedicated read-only/authentication canary route or prepare the future decision-action route boundary, but it must remain separately reviewed. Before any actual GitHub side effect is activated, the system must still:

- bind the live parent Access application issuer and exact AUD through separately reviewed Worker configuration;
- prove a real Access-authenticated request passes the Worker verifier while forged/missing tokens fail closed;
- re-read authoritative GitHub state immediately before every side effect;
- bind the approved expected SHA and action target;
- preserve idempotency and durable audit evidence;
- keep merge authorization separate from deployment authorization;
- add GitHub write permission only at the narrowest reviewed point where a concrete write transport requires it.

**Production deploy: NO.**
