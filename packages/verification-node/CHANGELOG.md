# Changelog

Notable changes to `@didww/verification-node`.

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — 2026-09

First release.

- `applicationAuth` — signed `application` auth for `@didww/verification-core`, so the secret is
  never sent. A malformed key or secret throws `ConfigurationError` at construction rather than on
  the first request.
- `Signer` — the five-line canonical string and its HMAC-SHA256, exported so a production signature
  mismatch can be diffed against the server.
- `CallbackVerifier` — authenticates an inbound verification callback against one application key
  pair or a resolver over many, with a fixed rejection order: size, signature, freshness, key,
  comparison, and the body parsed last, only once the signature holds.
- `expressCallbackHandler` — the express adapter. Answers status-only, catches its own errors so it
  behaves the same on express 4 and 5, and tries both `'/'` and `''` under `path: 'incoming'` so a
  callback URL registered at a bare origin verifies.
- Express is not a dependency, and the published declarations name no express type: the adapter's
  request and response types are structural.
