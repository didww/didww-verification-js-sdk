# Security

## Reporting a vulnerability

Email <support@didww.com>. Do not open a public issue.

## Credential handling

The `application` and `basic` auth modes carry a secret and are for server use only. Shipping either
in a mobile or browser build exposes the secret to anyone who unpacks it. Client applications use
`public` auth, which carries no secret, or call your own server.

`@didww/verification-core` never writes a credential to a log. The optional logger records method,
URL and status, and masks runs of six or more digits so a `by_number` path cannot leak a destination.
