# Phase 5 signed observation compatibility vectors

Issue #618 freezes a language-neutral compatibility oracle for the sanitized Phase 5 RPi5 observation protocol. The canonical machine-readable artifact is:

`tests/fixtures/phase5-rpi5-signed-observation-compatibility-v1.json`

Its stable contract identifier is:

`control-phase5-rpi5-signed-observation-compatibility-v1`

The fixture is synthetic, public and non-production. It contains two public Ed25519 test keys and precomputed signatures only. It contains no private signing material, no production verification-key value, no credential, and no authority to read or mutate an RPi5 host, Cloudflare Worker, D1 database, Queue, binding, route or secret. The fixture keys must never be copied into a production registry.

## Consumer contract pinned by the vectors

The vectors pin the already-merged Control consumer rather than inventing a second protocol:

1. delivery metadata is exact and versioned by `control-phase5-rpi5-observation-v1`;
2. `keyId` selects one exact public key from `control-phase5-rpi5-verification-keys-v1`; there is no fallback key;
3. Ed25519 verification covers the domain-separated metadata plus the exact raw payload bytes;
4. JSON is parsed only after signature verification;
5. the parsed object must satisfy the strict ten-field sanitized production-visibility contract;
6. the verified replay identity is `${keyId}:${deliveryId}`;
7. replay identity remains active until its derived expiry;
8. production visibility advances only when incoming `observedAt` is strictly newer than the stored projection.

The signing input is UTF-8 bytes for this prefix followed immediately by the raw payload bytes:

```text
rozkalns-control-center.phase5.rpi5-production-visibility.v1
<version>
<deliveryId>
<sentAt>
<keyId>
<payloadByteLength>
<rawPayloadBytes>
```

Every line in the prefix, including the payload byte length line, ends with `\n`. `payloadByteLength` is the UTF-8 byte length of the exact payload. Producers must not parse and reserialize a payload before verifying or reproducing a vector signature.

## Vector matrix

| Vector | Contract result |
| --- | --- |
| `canonical-drifted` | signature verifies; strict payload normalization yields the pinned `DRIFTED` read model |
| `reordered-equivalent` | independently signed reordered JSON verifies and normalizes to the same read model |
| canonical signature + reordered bytes | `Rpi5ObservationTransportError/INVALID_SIGNATURE` |
| malformed delivery UUID | `Rpi5ObservationTransportError/INVALID_INPUT` |
| unexpected delivery metadata field | `Rpi5ObservationTransportError/UNEXPECTED_FIELD` |
| `stale-delivery` | `Rpi5ObservationTransportError/STALE_DELIVERY` |
| `future-delivery` | `Rpi5ObservationTransportError/STALE_DELIVERY` |
| `wrong-key-selection` | exact secondary-key selection makes the primary-key signature fail with `INVALID_SIGNATURE` |
| `malformed-json` | transport verifies, then JSON parsing fails with `Rpi5ObservationIngestionError/INVALID_PAYLOAD` |
| `wrong-project` | transport verifies, then strict visibility identity fails with `IDENTITY_MISMATCH` |
| `malformed-sha` | transport verifies, then strict SHA validation fails with `INVALID_INPUT` |
| `contradictory-state` | transport verifies, then `UNREACHABLE` + `PASS` fails with `CONTRADICTORY_EVIDENCE` |
| `noncanonical-observed-at` | transport verifies, then non-canonical timestamp syntax fails with `INVALID_INPUT` |
| `freshness-ceiling` | metadata/signature verification succeeds at exactly 300000 ms age, but full ingestion fails closed because replay expiry equals acceptance time |
| `active-replay` scenario | first delivery `STORED`; same replay identity again fails `ACTIVE_REPLAY` |
| `monotonic-projection` scenario | baseline `STORED`; equal and older `observedAt` are `NOT_NEWER`; strictly newer `observedAt` is `STORED` |

### Freshness boundary

The current merged layers have an intentionally recorded end-to-end boundary detail that an external producer must reproduce rather than infer:

- transport metadata normalization rejects age `< 0` and age `> 300000 ms`;
- therefore the exact `300000 ms` metadata boundary can still verify;
- replay expiry is `sentAt + 300000 ms`;
- replay/acceptance storage requires that expiry to be strictly later than the acceptance time;
- consequently a delivery whose age is exactly `300000 ms` fails full ingestion with `Rpi5ObservationAcceptanceError/INVALID_INPUT`.

This vector records current behavior without changing runtime semantics. A future source change that deliberately alters the boundary must version this compatibility contract rather than silently changing the v1 fixture.

## How the RPi5 implementation should use this artifact

A separately owned RPi5 implementation can copy the JSON fixture into its own test suite and prove that its protocol implementation:

- constructs the exact signing input bytes represented here;
- emits/consumes the exact transport and registry versions;
- performs exact `keyId` selection;
- reproduces the success and fail-closed outcomes above;
- preserves raw-payload byte identity across signature handling;
- treats replay and monotonic projection outcomes as protocol-visible consumer behavior.

Passing these vectors proves compatibility with the repository source contract only. It does not prove that production keys are provisioned, a Worker is deployed or activated, D1 migrations are applied, the RPi5 signer is running, or any LIVE observation was delivered.
