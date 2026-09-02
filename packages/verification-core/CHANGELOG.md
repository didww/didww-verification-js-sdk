# Changelog

Notable changes to `@didww/verification-core`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Two names are excluded from semver and may change in any release:
`Verification.unsafeRawPayload` and `INTERNAL_APP_HASH_KEY`.

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
