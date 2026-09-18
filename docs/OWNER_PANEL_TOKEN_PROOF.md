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
- rate/resource limits -> `GRAPHQL_RATE_LIMITED`;
- provider 5xx / documented internal-unavailable errors ->
  `GRAPHQL_SERVICE_UNAVAILABLE`;
- documented query/dataset rejection -> `GRAPHQL_QUERY_REJECTED`;
- malformed, unexpected or otherwise non-proving responses remain fail-closed as
  `GRAPHQL_RESPONSE_UNPROVEN`, `GRAPHQL_HTTP_UNPROVEN` or
  `GRAPHQL_REQUEST_UNPROVEN`.

The public receipt contains only `graphql_authorization_proven`,
`production_mutations` and a fixed result enum. It never prints the bearer token,
target account, query, variables, synthetic Ray ID, provider error message, headers
or raw response body.

This proof establishes only whether the existing protected bearer can execute the
fixed GraphQL Analytics read. It does not prove the Access service-token Client
Secret, explain the Worker health 403 by itself, authorize credential/permission
changes, or make owner-panel activation ready.

Official Cloudflare documentation checked for this implementation:

- https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
- https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/
- https://developers.cloudflare.com/analytics/graphql-api/errors/
