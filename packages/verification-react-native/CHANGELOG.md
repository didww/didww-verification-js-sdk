# Changelog

Notable changes to `@didww/verification-react-native`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0 — 2026-10

### Added

- `StartInput.custom` — passed through to `startVerification` and forwarded to the callback server
  as `data.custom`. The value is set on the device, so treat it as untrusted there.
- `sms.autofill` on `start` (`app_hash`, `domain` or `none`) replaces the device-computed app hash.
  With `domain` or `none` the hash is not computed and the listener stays off; with `app_hash` your
  value is sent and, when `autoCapture` is on, the listener arms against it.
- `templateGroup` on the `sms` and `callout` blocks, and `templateGroup`, `templateGroupUsed` and
  `templateFallbackReason` on `state.sms` and `state.callout`, from `@didww/verification-core`
  1.2.0, along with its new error and outcome codes.

### Changed

- A submit refused with `rate_limit_per_ip`, `rate_limit_failed_auth`, `rate_limit_per_account` or
  `rate_limit_public_per_account` is retried once after `Retry-After` when that is at most 5
  seconds. If the wait is longer, or the retry is rate-limited too, the state returns to `awaitingInput` with the error in `lastError`
  rather than ending the verification. A rate-limited start, and `volume_limit_reached`, stay
  terminal.
- A start answered with outcome `application_paused` ends in `setupError`, and one answered with
  `destination_country_disabled` in `denied`. `destination_not_supported_for_channel` ends in
  `failed`, like any other failure.
- The device-computed app hash is sent as `sms.autofill`, and the listener arms on the echoed
  `sms.autofill` rather than the deprecated flat `app_hash`.

### Deprecated

- The `stale_dispatch` outcome code, as in `@didww/verification-core`: the service reports
  `dispatch_failed` instead.

## 1.1.0 — 2026-10

- Kept in step with `@didww/verification-core` 1.1.0 (`SmsInfo.codeLength`/`CalloutInfo.codeLength`,
  `destination_in_cooldown`, `RateLimitedError`), both carried through `state.sms`/`state.callout`
  unchanged. No change to this package's own code.

## 1.0.0 — 2026-09

First release.

- `useVerification()` — one verification from start to outcome, with `start`, `resume`, `resumeById`,
  `submit` and `reset`. Nothing throws and nothing returns a promise; every outcome arrives as a new
  `state`. Start and submit are each single-flighted, an early `submit` is buffered until the
  verification is live, and unmounting aborts the request in flight.
- `VerificationState`, `FailureReason` and `SdkError` — the union the host renders from, with the
  recoverable/terminal split decided by the server's error slug rather than a local attempt counter.
- Android SMS auto-capture: the app hash is read from the device, sent with the start request, and the
  code is extracted from the matching message into `state.kind === 'captured'`. It arms only when the
  server echoes back the hash that was sent.
- `getAppHash()` and `isSmsAutoCaptureAvailable()` — both answer for the linked native module, not for
  the platform, so Expo Go and a bare app without Expo Modules report honestly instead of promising a
  capture that cannot happen.
- `otpInputProps` for the host's code input.
- `expo-modules-core` is an optional peer dependency. A bare React Native app without it builds and
  runs; auto-capture is off and manual entry is unaffected.
