# Security

## Reporting a vulnerability

Email <support@didww.com>. Do not open a public issue.

## Credential handling

The `application` and `basic` auth modes carry a secret and are for server use only. Shipping either
in a mobile or browser build exposes the secret to anyone who unpacks it. Client applications use
`public` auth, which carries no secret, or call your own server.

`@didww/verification-core` never writes a credential to a log. The optional logger records method,
URL and status, and masks every run of four or more digits that is not part of a UUID, so neither a
`by_number` path nor a verification code — 4 to 8 digits, chosen by the server — can leak. Ports,
years and durations are masked with them; verification ids stay readable for support.
