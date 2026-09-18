# Health403 detail diagnostic

This source-only diagnostic follows the protected owner-panel inventory failure recorded by workflow run `35369863943` on source `ed9327211c64e21ffefb3a5a67d5dfcef293a097`.

It adds one explicitly selected `health403-detail` operation to the existing `owner-panel-readonly-preflight.yml` workflow. The operation is diagnostic only and does not make production mutations.

## Bounded evidence

The diagnostic performs one fixed `GET https://control.rozkalns.net/api/health` using the existing protected service-token headers. Only after an HTTP 403 does it use the existing Access read token to:

- identify the already matching health Access application and selected service token;
- classify that token as enabled/unexpired, enabled/expired, disabled, or not proven from bounded metadata;
- run one fixed Access Analytics GraphQL lookup using the normalized 16-character Cloudflare Ray ID;
- distinguish documented top-level `Unauthorized` and `Internal server error` responses from the existing bounded GraphQL categories.

The public receipt never includes Client ID, Client Secret, API token, service-token ID, expiration timestamp, Ray ID, raw response body, provider error message, application ID, policy selector, or GraphQL dimensions.

`client_secret_validity` is deliberately reported as `NOT_PROVEN_BY_METADATA`; Cloudflare does not return an existing service token's secret for comparison. This diagnostic therefore does not justify secret rotation by itself.

## Safety boundary

- no workflow dispatch is authorized by this source change;
- no retry is implemented;
- no D1 query or write;
- no Worker upload/deploy;
- no Access application, policy, service-token, secret, or permission mutation;
- no GitHub permission mutation;
- `production_mutations` remains `0` and `activation_ready` remains `false` in every receipt.

A future protected run requires a separate owner authorization after this source is reviewed, merged, and exact-main CI is green.
