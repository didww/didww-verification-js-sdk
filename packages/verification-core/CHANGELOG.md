# Changelog

Notable changes to `@didww/verification-core`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Two names are excluded from semver and may change in any release:
`Verification.unsafeRawPayload` and `INTERNAL_APP_HASH_KEY`.

## 1.2.0 — Unreleased

### Added

- `StartOptions.custom` — up to 4096 characters of text, forwarded unchanged to your callback server
  as `data.custom`. It is not returned on the verification. A longer value is refused with the new
  `custom_too_long` error code.
- `SmsOptions.autofill` — `{ type: 'app_hash', value }`, `{ type: 'domain' }` or `{ type: 'none' }`
  (`SmsAutofillOption`). `SmsInfo.autofill` reads back the stored marker, `app_hash` or `domain`,
  whose `value` is the hash or the domain. New error codes `autofill_invalid` and
  `sms_domain_not_configured`.
- `templateGroup` on `SmsOptions` and `CalloutOptions`, to pick a template group instead of the
  application's default. `SmsInfo` and `CalloutInfo` gain `templateGroup`, `templateGroupUsed` and
  `templateFallbackReason`, the last an open vocabulary (`TEMPLATE_FALLBACK_REASONS`,
  `TemplateFallbackReason`). `templateGroupUsed` false with a null reason means no group applies;
  `group_missing` comes with a null `templateGroup`, as the group no longer exists. An unknown group
  is refused with the new `template_group_not_found` error code.
- New error codes for 429, all raising `RateLimitedError`: `rate_limit_per_ip` (too many requests
  from this IP address), `rate_limit_failed_auth` (too many failed authentication attempts from this
  IP address), `rate_limit_per_account` (too many requests for this account),
  `rate_limit_public_per_account` (too many public requests for this account) and
  `volume_limit_reached` (the application reached its daily or monthly verification limit for this
  delivery method; `Retry-After` can be days, so surface it instead of retrying).
- New outcome codes in `VERIFICATION_ERROR_CODES`: `application_paused` and
  `destination_country_disabled` (status `denied`), and `destination_not_supported_for_channel`
  (status `failed`).

### Changed

- An unsupported destination (no country, no delivery for the channel, or a blocked range) is no
  longer refused with a 422. The start answers 201 with status `failed` and `errorCode`
  `destination_not_supported_for_channel`, so code that caught the 422 now gets a failed
  verification. The code stays in `API_ERROR_CODES` for compatibility.
- `SmsInfo` gains four fields required by the type (`autofill`, `templateGroup`, `templateGroupUsed`,
  `templateFallbackReason`) and `CalloutInfo` the last three: an object literal typed `SmsInfo`,
  `CalloutInfo` or `Verification` — a test mock, most likely — now needs them added.
- The device app hash handed over by `@didww/verification-react-native` is sent as
  `sms.autofill`. Giving it together with `SmsOptions.autofill` throws `ConfigurationError`.

### Deprecated

- `SmsInfo.appHash` — use `SmsInfo.autofill`. It is `autofill.value` when the type is `app_hash`,
  else `null`.
- The `stale_dispatch` outcome code. The service no longer sends it and reports these
  verifications as `dispatch_failed`. It stays in `VERIFICATION_ERROR_CODES` so existing matches
  keep type-checking, and will be removed in the next major version.

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
