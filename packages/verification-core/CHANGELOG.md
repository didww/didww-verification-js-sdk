# Changelog

Notable changes to `@didww/verification-core`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Two names are excluded from semver and may change in any release:
`Verification.unsafeRawPayload` and `INTERNAL_APP_HASH_KEY`.

## 1.2.0

Unreleased.

- `StartOptions.custom` — up to 4096 characters of text, sent as the top-level `custom` key and
  forwarded unchanged to the callback server as `data.custom`. It is not returned on the verification.
- `'custom_too_long'` in `API_ERROR_CODES` — the start is refused with it when `custom` is too long.

## 1.1.0 — 2026-10

- `SmsInfo.codeLength` and `CalloutInfo.codeLength` — the generated code's length, 4–8, set per
  application on the server. **Both fields are required by the type**, not optional: an object
  literal typed `SmsInfo`, `CalloutInfo` or `Verification` — a test mock, most likely — now needs
  `codeLength` added or it stops compiling.
- `'destination_in_cooldown'` in `API_ERROR_CODES` — a start for the same application and
  destination too soon after a non-denied one is refused with it.
- `RateLimitedError` — thrown for a 429, carrying `retryAfterSeconds` read off the `Retry-After`
  header (`null` when the response carried none). `startVerification` is never retried
  automatically on any status, 429 included.
- The optional logger's redaction now masks every run of four or more digits outside a UUID,
  rather than six or more: the generated code is 4–8 digits, chosen by the server, and a shorter
  run would leak it. Ports and years are masked along with it; a verification id stays readable.
- Every request now carries `X-User-Agent: didww-verification-<runtime>/<version>`. The runtime
  is detected once at construction: React Native, then Node, then plain `didww-verification-js`.
- `ClientOptions.userAgent` is deprecated and ignored: the SDK identifies itself with the
  `X-User-Agent` header above. Will be removed in the next major version.

## 1.0.0 — 2026-09

First release.

- `VerificationClient` with `startVerification`, `reportVerification`, `getVerification`,
  `reportVerificationByNumber` and `getVerificationByNumber`, plus the `reportVerificationRaw` and
  `reportVerificationRawByNumber` escape hatches for a channel this release does not model.
- `basicAuth` and `publicAuth`, and the `AuthProvider` seam that `application` auth plugs into from
  `@didww/verification-node`.
- `fetchTransport`, and the `Transport` interface for supplying your own.
- Retries on `GET` only, two attempts by default with jittered backoff. A start or a report is never
  retried.
- Decoded models — `Verification`, `SmsInfo`, `VerificationResult` — where `fee` is a decimal string
  and a status, channel or error code this release does not model decodes as the string received.
- The error tree under `DidwwError`, with `isDidwwError` and `isApiError` guards that hold across
  two installed copies of this package.
- The `./testing` subpath: `fakeTransport`, a scripted transport double that records every request.
- No runtime dependencies, and no runtime-specific API.
