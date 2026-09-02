# Wire contract snapshot

`wire-contract.json` records the parts of the DIDWW Verification API that the generated OpenAPI
document cannot express, plus the field and path shapes the SDK is checked against: paths, response
and request fields, constraints, auth schemes, the string-to-sign, and the inbound callback.

## What is deliberately not here

The four vocabularies — delivery methods, statuses, verification error codes, API error codes. Those
live once, in the arrays exported from `@didww/verification-core`, and nothing mirrors them. A
second copy here would have to be edited in step with the first, and the comparison between the two
would prove only that someone edited both.

Everything that reads a vocabulary reads it from the package: `examples/mock-api` resolves every
slug it can emit against `API_ERROR_CODES` at module load, `check-slug-parity.mjs` takes the 22/9
split axis from `VERIFICATION_ERROR_CODES`, and `contract-check.mjs` folds all four in from source
before comparing them to the specification.

## What this file is for

It is the SDK's independent statement of the wire, written by hand so that comparing it against a
generated specification means something. `contract-check.mjs` runs that comparison at release.

Four sections have no counterpart in the specification and never will: `authSchemes.public` and
`authSchemes.application` (only Basic is documented), `signing` (a string-to-sign is not expressible
in OpenAPI), `callback` (the document is OpenAPI 3.0.3, which has no `webhooks` section), and most
of `constraints` (lifetimes, attempt limits and resolution order are prose in both). For those, this
file is the only record anywhere — the service publishes them nowhere.

## What it cannot do

It is not a drift detector on its own. The only real drift check runs manually at release, against a
freshly generated API specification, and `contract-check.mjs` prints which sections it had to skip.

## `capturedAt`

The date the file was last checked against a generated specification. `contract-check.mjs` warns
once it is more than 90 days old, and fails outright if it is missing or unparseable — an undated
snapshot can never be reported stale, so the warning would be silently unreachable. Move the date
when you have actually re-run the comparison, not when you edit the file.
