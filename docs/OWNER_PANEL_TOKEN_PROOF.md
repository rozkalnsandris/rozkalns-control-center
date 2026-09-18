# Protected Access credential Analytics proof

Source-only follow-up for #689. The existing protected workflow maps the exact
Access-read secret into a separate `token-analytics-proof` operation. The default
`none` performs offline tests only; `inventory` must be selected explicitly for
the historical preflight. The proof operation never calls health, GraphQL, Access
inventory, D1, or Worker APIs. Source preparation is not dispatch authorization.
Merge, successful CI on current main, and the applicable explicit dispatch
contract must precede any protected run. Do not replay the earlier dispatch.

The token remains in memory. Documented `cfut_` / `cfat_` prefixes choose exactly
one user/account self-verification GET. A prefix only selects the endpoint; the
successful response must also prove an active identity. Unprefixed legacy tokens
cannot establish their type from their format and stop without a network call;
there is no fallback, second verify, rotation, or new credential request.

After successful verification, one GET reads that exact token's details with the
same bearer. The server enforces existing metadata authority. User details require
API Tokens Read (or an already-existing Write grant); account-owned details require
Account API Tokens Read (or an existing Write grant). A denied metadata read is
not evidence that Analytics permission is missing. No other credential is tried.
Returned identity and active status must match; IDs and bodies are never emitted
or persisted, and redirects and retries are disabled.

Policy evaluation requires the documented `Account Analytics Read` name and the
target account resource or account wildcard in the same allow policy. Unsupported
policy effects, incomplete permission names, or complex Analytics resource scopes
return `POLICY_UNPROVEN`. Supported complete policies with no matching grant return
`ANALYTICS_NOT_GRANTED_FOR_TARGET`. A matching grant proves metadata configuration,
not an explanation of the historical health 403 or live panel readiness.

Public receipts contain only fixed result enums and booleans. The permission-group
names are inspected privately; response fields, identifiers, exception messages,
headers, token format/value, and metadata are never interpolated into output.

Official documentation checked for this implementation:

- https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/
- https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/
- https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
- https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/get/
- https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/get/
- https://developers.cloudflare.com/fundamentals/api/reference/permissions/
