# Mock verification API

A small, in-memory stand-in for the DIDWW Verification API. It exists so the examples and the
integration tests can run a whole verification — including the outbound callback — with no
credentials, no account and no publicly reachable URL.

Zero dependencies of any kind: `node:http` and `node:crypto`, nothing else. It is not an npm
workspace member and installs nothing; `tsx` comes from the repository root.

**What it is for:** exercising the shape of the protocol — routes, auth schemes, signatures, the
callback handshake, and the state transitions a client has to survive. **What it is not:** an
authority on the API's behaviour. It and the SDK were written from the same reading of the same
snapshot, so agreement between them is not evidence. Where the snapshot is silent, this server
guesses, and every guess is listed under [Where this is a guess](#where-this-is-a-guess).

## Running it

```sh
npm start --prefix examples/mock-api          # PORT=4000 by default
PORT=8080 npm start --prefix examples/mock-api
CALLBACK_BASE_URL=http://127.0.0.1:9000 npm start --prefix examples/mock-api
```

`CALLBACK_BASE_URL` is the origin the seeded applications register their callback URLs under. In
process, for tests:

```ts
import { createMockApi } from './examples/mock-api/src/server.ts';

const api = await createMockApi({ port: 0, callbackBaseUrl: receiver.origin }).listen();
// api.url, api.port, api.state
await api.close();
```

`createMockApi` also takes `applications`, `code`, `cli`, `fee`, `verificationLifetimeSeconds` and
`callbackTimeoutMs`. Passing `applications` replaces the seeded set entirely.

## Routes

The route table is compiled from `contract/wire-contract.json` at boot, so the paths and verbs are
the snapshot's rather than a second copy of them. An operation the snapshot adds without a handler
here fails the boot instead of 404ing quietly.

| Method          | Path                                       |                                    |
| --------------- | ------------------------------------------ | ---------------------------------- |
| `POST`          | `/api/v1/verifications`                    | start, `201`                       |
| `GET`           | `/api/v1/verifications/{id}`               | `200`                              |
| `PUT` / `PATCH` | `/api/v1/verifications/{id}`               | report — one operation, not two    |
| `GET`           | `/api/v1/verifications/by_number/{number}` | newest verification for the number |
| `PUT` / `PATCH` | `/api/v1/verifications/by_number/{number}` | report                             |

Errors always use the envelope `{"errors":[{"code":"…","detail":"…"}]}`, one element per failed
field. `detail` is fixed prose selected by `code` — switch on the code and treat the prose as
display-only.

## Authentication

Three schemes, dispatched **by the colon in the `Application` credential**:

| Header                                                           | Scheme        |
| ---------------------------------------------------------------- | ------------- |
| `Authorization: Application <key>:<signature>` (+ `x-timestamp`) | `application` |
| `Authorization: Application <key>`                               | `public`      |
| `Authorization: Basic base64(key + ":" + secret)`                | `basic`       |

Each application carries a minimum scheme, ranked `public < basic < application`. A request below it
is rejected. Every failure — unknown key, wrong secret, bad signature, stale timestamp, too weak a
scheme — answers `401` with the `unauthorized` code and nothing else; anything more precise would
turn the endpoint into an oracle for which keys exist.

### Signature

HMAC-SHA256, base64-encoded. The key is the URL-safe-base64 **decode** of the application secret —
the raw bytes, never the secret's characters. The string to sign is exactly five lines joined with
`\n`, no trailing newline:

```
<HTTP-METHOD>
<CONTENT-MD5>
<CONTENT-TYPE>
x-timestamp:<TIMESTAMP>
<PATH>
```

- `CONTENT-MD5` is base64 of the MD5 of the body bytes, and **empty** when the body is absent,
  empty, or whitespace only.
- `CONTENT-TYPE` is the exact header value received, and **empty when no header was sent**. A
  bodyless request must send no `Content-Type` header at all; a client that defaults one on every
  request 401s every signed GET, and a test that runs the client against its own signer cannot see
  it — the two agree while both disagree with the server.
- `<PATH>` is the undecoded request-target path with the query excluded, byte-identical to the
  request line. Percent-encoded segments stay percent-encoded.
- `x-timestamp` is Unix epoch **seconds**, the same value in the header and on the fourth line,
  accepted within 300 seconds either way.

## Callback

Sent when a start is authenticated with `basic` or `public` **and** the application has a callback
URL registered. Never for a signed start — that caller is already trusted.

```
POST <registered callback URL>
Content-Type: application/json
Authorization: Application <key>:<signature>
x-timestamp: <unix epoch seconds>

{"event":"verification_request","data":{"id":"…","destination":"…","delivery_method":"sms"}}
```

The signature covers **the path of the registered URL**, not the path the request arrives on. A URL
registered at a bare origin (`https://example.com`, or `https://example.com?x=1`) is signed against
the **empty string**, not `/`. A receiver that defaults to the pathname it was called on computes a
valid signature over `/`, mismatches every time, and denies 100% of that application's
verifications. The seeded `app_public_bare_origin` exists so that case is exercisable.

The answer decides the verification, once — there is no retry:

| Answer                                                                                                               | Outcome                                              |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `2xx` with `{"action":"allow"}`                                                                                      | proceeds, `pending`                                  |
| `2xx` with `{"action":"deny"}`                                                                                       | created `denied`, `denied_by_callback`               |
| any non-2xx, a non-JSON body, an `action` that is neither, a body over 8192 bytes, a connection failure or a timeout | created `denied`, `denied_invalid_callback_response` |

A `public` start on an application with **no** callback URL is created `denied` with
`denied_missing_callback_url` and no outbound request is made — the callback is what authorizes it.
The same start over `basic` proceeds.

## Seeded applications

Callback URLs are shown relative to `CALLBACK_BASE_URL` (default `http://127.0.0.1:4010`).

| Key                      | Minimum scheme | Callback URL                   |
| ------------------------ | -------------- | ------------------------------ |
| `app_signed_only`        | `application`  | —                              |
| `app_basic`              | `basic`        | —                              |
| `app_basic_callback`     | `basic`        | `$BASE/callbacks/verification` |
| `app_public_callback`    | `public`       | `$BASE/callbacks/verification` |
| `app_public_bare_origin` | `public`       | `$BASE` — no path, signs `""`  |
| `app_public_no_callback` | `public`       | — starts are denied            |

Secrets are printed on boot along with the table. The verification code is fixed (`123456`) so a
client can report the right value without reading a message.

## Behaviour reproduced

- **Supersede on a second start.** Starting a verification supersedes any unfinished one for the
  same application and number; the superseded row reads `failed` / `superseded` and is reachable
  only by id.
- **Three report attempts.** The fourth answers **`200` with status `failed` and error_code
  `too_many_attempts`** — not a 4xx. Whether another attempt is allowed is the server's decision;
  do not count attempts in a client.
- **`expired` is synthesised on read.** An unfinished verification past `expires_at` reads as
  `expired` with error_code `expired`, with nothing written, so a poll reaches the state on its own.
- **By-number resolution** returns the newest verification for the number, finished ones included.
- **Destination normalisation** strips every non-digit including the leading `+`; spaces, hyphens
  and parentheses are separators and `.` is not, so `+371.12345678` is rejected rather than
  normalised. A `.` in the last path segment is read as a format suffix, which is why the same value
  in a `by_number` path silently addresses a different number.
- **Language tags** are validated loosely and matched strictly: `pl` passes validation and then
  falls back to `en-US`, because templates are keyed on the exact canonical tag.
- **`app_hash`** is validated on every start once supplied; a malformed one fails the whole
  verification with `app_hash_invalid`, and the key is omitted from the response unless a hash was
  stored.

The vocabulary — statuses, delivery methods, error codes — is read from
`@didww/verification-core`, and every slug this server emits is resolved against it at module load,
so a rename on either side fails the boot rather than serving a value the SDK no longer knows.

## Proof

```sh
npm run proof --prefix examples/mock-api
```

Boots the server and a stub callback receiver and drives the whole surface over real HTTP: all five
routes, all three schemes accepted and each rejected, a signature computed by a second
implementation that shares no code with the server, both callback outcomes and five ways of being
invalid, the bare-origin signature, supersede, attempt exhaustion, expiry synthesis, and a bodyless
signed GET sent with no `Content-Type` header. It exits non-zero on the first failed assertion.

`proof/` is scaffolding, not part of the mocked service: the receiver is the _customer's_ side of
the callback and `proof/signing.ts` is a deliberate second implementation of the signature.

## Where this is a guess

The snapshot does not pin these, so they are the places this server is most likely to disagree with
the real API. Do not build a client behaviour on them.

- **Error `detail` prose.** The codes are the snapshot's; the sentences are invented.
- **`fee`** is a constant (`0.0345`), and the SMS templates are three invented strings.
- **Which validation code a wrongly-typed value gets.** A non-string `destination` is
  `destination_invalid` and a blank one `destination_blank`; a non-object `sms` block is ignored.
- **Reporting a finished verification** answers `422 not_ready_to_report`, and reporting a verified
  one `422 already_verified`. An expired row takes the former.
- **A wrong code is `422 code_invalid`** and consumes one of the three attempts. A request that fails validation consumes none.
- **A denied start still supersedes** an earlier unfinished verification for the same number.
- **A verification belonging to another application is `404`**, not `403`.
- **An unrouted path answers the JSON error envelope** with `not_found`; the real service sits behind
  a stack that may answer otherwise, which is why a decoder must survive a non-JSON body.
- **The `Basic` and `Application` scheme tokens are matched case-sensitively.**
- **The callback timeout** is 5 seconds; the snapshot fixes the read limit and the retry count but
  not this.
- **The response `Content-Type` of a callback answer is ignored**; only whether the body parses as
  JSON matters.
