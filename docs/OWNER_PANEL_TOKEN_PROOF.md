# Protected Access credential Analytics proof

Source-only Health403 diagnostic support for the protected `token-analytics-proof`
operation. The workflow injects only `CLOUDFLARE_ACCESS_READ_TOKEN`; source
preparation is not dispatch authorization. Merge, successful exact-main CI and a
separately explicit read-only dispatch gate are still required before a protected
run. No retry is implied by a previous failed run.

## Direct GraphQL authorization proof

The proof does not inspect `/user/tokens/*` or `/accounts/*/tokens/*` metadata.
Token-metadata authority is separate from GraphQL Analytics authority, so a denied
metadata read cannot prove whether `Account Analytics Read` exists.

Instead, the proof performs exactly one bounded POST to the documented Cloudflare
GraphQL Analytics endpoint with the existing bearer credential. The query is fixed
to the configured target account and the Access login dataset, uses a synthetic
16-hex Ray ID, a five-minute UTC window and `limit: 1`, and requests no production
mutation. Redirects and retries are disabled and the response body is capped at
262144 bytes.

A successful HTTP 200 GraphQL response with `errors: null`, exactly one target
account result and a bounded dataset list proves `ANALYTICS_GRANTED_FOR_TARGET`.
The dataset may be empty: authorization is proven by successful execution of the
fixed account/dataset query, not by the presence of an Access login event.

Authentication and authorization failures remain distinct:

- HTTP 401 or a GraphQL `Unauthorized` error -> `TOKEN_AUTHENTICATION_FAILED`;
- HTTP 403 or documented account/path/zone authorization errors ->
  `ANALYTICS_NOT_GRANTED_FOR_TARGET`;
- rate/resource limits, including Cloudflare's documented `rate limiter budget
  depleted` class -> `GRAPHQL_RATE_LIMITED`;
- provider 5xx / documented internal-unavailable errors ->
  `GRAPHQL_SERVICE_UNAVAILABLE`;
- documented query/dataset rejection -> `GRAPHQL_QUERY_REJECTED`.

## Bounded response-shape diagnostic

Cloudflare documents that GraphQL Analytics responses contain an `errors` field:
`null` when there are no errors, otherwise an array of error objects. Run
`35377552789` returned the previous generic `GRAPHQL_RESPONSE_UNPROVEN`, so the
source now separates only response-shape classes while continuing to suppress raw
provider details:

- non-object JSON -> `GRAPHQL_RESPONSE_NOT_OBJECT`;
- object without the documented `errors` field -> `GRAPHQL_ERRORS_FIELD_MISSING`;
- `errors: null` with an unexpected `data/viewer/accounts` shape ->
  `GRAPHQL_SUCCESS_DATA_SHAPE_UNPROVEN`;
- `errors: null` where the fixed target account cannot be bound to exactly one
  account result -> `GRAPHQL_SUCCESS_TARGET_ACCOUNT_UNPROVEN`;
- `errors: null` with an unexpected bounded Access dataset shape ->
  `GRAPHQL_SUCCESS_DATASET_SHAPE_UNPROVEN`;
- malformed/empty/oversized `errors` arrays -> `GRAPHQL_ERRORS_SHAPE_UNPROVEN`;
- well-formed non-empty `errors` whose messages do not match a documented bounded
  class -> `GRAPHQL_ERRORS_UNCLASSIFIED`.

These enums identify only the response boundary that failed closed. They do not
print error messages, error paths, timestamps, account counts, dataset contents or
any other provider payload details, and they do not reinterpret an unclassified
response as proof of authorization or denial.

Transport/decode problems remain `GRAPHQL_HTTP_UNPROVEN` or
`GRAPHQL_REQUEST_UNPROVEN`. The public receipt still contains only
`graphql_authorization_proven`, `production_mutations` and a fixed result enum. It
never prints the bearer token, target account, query, variables, synthetic Ray ID,
provider error message, headers or raw response body.

This proof establishes only whether the existing protected bearer can execute the
fixed GraphQL Analytics read. It does not prove the Access service-token Client
Secret, explain the Worker health 403 by itself, authorize credential/permission
changes, or make owner-panel activation ready.

Official Cloudflare documentation checked for this implementation:

- https://developers.cloudflare.com/analytics/graphql-api/
- https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/
- https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-access-login-events/
- https://developers.cloudflare.com/analytics/graphql-api/errors/
