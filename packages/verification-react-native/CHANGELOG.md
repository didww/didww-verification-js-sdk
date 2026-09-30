# Changelog

Notable changes to `@didww/verification-react-native`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0

Unreleased.

- `StartInput.custom` — passed through to `startVerification` and forwarded to the callback server as
  `data.custom`. The value is set on the device, so treat it as untrusted there.

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
