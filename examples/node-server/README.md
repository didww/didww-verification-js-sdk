# Node backend example

An Express server for a mobile verification app. Two halves, and they are independent:

- **A start/report proxy** — thin routes that call `VerificationClient` with signed `application`
  auth, so the application secret stays on the server and never ships in an app binary.
- **The inbound callback gate** — `POST /callbacks/didww`, where the API asks whether to start a
  verification your device began with `public` or `basic` auth. Until this endpoint answers
  correctly, every such verification is denied.

Zero dependencies of its own: `express`, `tsx` and `typescript` come from the repository root, and
`@didww/verification-core` / `@didww/verification-node` from the workspace. It is not an npm
workspace member and installs nothing.

## Configure

```sh
cp .env.example .env
```

`.env.example` is annotated; the variables are `BASE_URL`, `PORT`, `APPLICATIONS`,
`APPLICATION_KEY`, `CALLBACK_ROUTE`, `CALLBACK_SIGNED_PATH` and `DENY_DESTINATION_PREFIX`.
`BASE_URL` defaults to the mock; point it at `https://verification-sandbox.didww.com` (or
`https://verification.didww.com`) with your own credentials in `APPLICATIONS` to run against the
real API — nothing else changes. Note that on the real API the callback URL is a property of the
application, registered out of band, and it must be reachable from the internet.

## Run it against the mock

Two terminals. `CALLBACK_BASE_URL` is the origin the mock's seeded applications register their
callback URLs under, so it must be this server:

```sh
PORT=4000 CALLBACK_BASE_URL=http://127.0.0.1:3300 npm start --prefix examples/mock-api
```

```sh
PORT=3300 CALLBACK_ROUTE=/callbacks/verification npm start --prefix examples/node-server
```

`CALLBACK_ROUTE` is overridden because the mock registers `/callbacks/verification` and **the route
you mount must be the path that is registered**. That is the whole lesson of the callback half; see
below.

Then, playing the mobile app — a `public` start goes straight to the API, not through this server:

```sh
# allowed
curl -sS -X POST http://127.0.0.1:4000/api/v1/verifications \
  -H 'content-type: application/json' \
  -H 'authorization: Application app_public_callback' \
  -d '{"data":{"destination":"+12025550143","delivery_method":"sms"}}'
# -> "status":"pending"          the gate logged: ... sms -> allow

# denied by DENY_DESTINATION_PREFIX=1900
curl -sS -X POST http://127.0.0.1:4000/api/v1/verifications \
  -H 'content-type: application/json' \
  -H 'authorization: Application app_public_callback' \
  -d '{"data":{"destination":"+19005550100","delivery_method":"sms"}}'
# -> "status":"denied","error_code":"denied_by_callback"
```

Report the allowed one through this server (the mock's fixed code is `123456`):

```sh
curl -sS -X PUT http://127.0.0.1:3300/verifications/<id> \
  -H 'content-type: application/json' -d '{"delivery_method":"sms","value":"123456"}'
# -> "status":"verified"
```

## Routes

| Method | Path                  |                                          |
| ------ | --------------------- | ---------------------------------------- |
| `POST` | `/verifications`      | start — `{destination, delivery_method}` |
| `PUT`  | `/verifications/{id}` | report — `{delivery_method, value}`      |
| `GET`  | `/verifications/{id}` | poll                                     |
| `POST` | `/callbacks/didww`    | the inbound gate (`CALLBACK_ROUTE`)      |

The proxy routes forward the API's status and its `{"errors":[…]}` envelope unchanged, so the
client switches on `code` exactly as it would against the API.

**Never re-send a start or a report on a timeout.** A report is not idempotent and only three
attempts exist; a second start supersedes the first and is billed again. Call `GET` instead — the
SDK retries that one for you, and only that one.

## The callback gate

`src/callbacks.ts` is the whole thing. Four points, and each is a way to deny 100% of your
verifications while both sides hold valid signatures:

**1. The raw bytes.** `express.raw({ type: '*/*' })` is mounted **on that route only**. A body
re-serialized by `express.json()` is not what was signed. The adapter throws a `ConfigurationError`
rather than guessing, so this fails loudly — but only once a callback arrives.

**2. `path` is the REGISTERED URL's path**, not the path the request arrived on, and it is passed
explicitly. The API signs that URL's path component, query excluded:

| Registered callback URL        | `path`                |
| ------------------------------ | --------------------- |
| `https://example.com/cb/didww` | `'/cb/didww'`         |
| `https://example.com`          | `''` — **not** `'/'`  |
| `https://example.com?x=1`      | `''` — query excluded |

A bare origin signs the **empty string**. An endpoint that assumes `'/'` there denies every
verification for that application. The two also differ whenever a proxy or ingress rewrites the
path before your server sees it, which is the other reason this is never read off the request.

**3. `secret` is a resolver, not a fixed string.** One endpoint may serve several applications; the
key arrives in each callback's `Authorization` header, and returning `null` for an unknown one is
what makes it unknown.

**4. The answer decides the verification, once.** A `2xx` must **carry** `{"action":"allow"}` or
`{"action":"deny"}` in the body — an empty `200` is read as an answer the API cannot use, and any
non-2xx, unparseable body or timeout denies the verification. Nothing is retried.

`onRejected` exists to log why a callback was refused. The reply itself is a bare status with no
body on purpose: echoing the reason would tell an unauthenticated caller which application keys
exist.

**A start this server signs is never gated.** The callback authorizes a start the device made with
`public` or `basic` auth; `POST /verifications` here is already trusted, so it goes straight to
`pending` and the gate is not asked.

## An unknown delivery method

The channel reaches `PUT /verifications/{id}` as an untrusted string, and `ReportOptions` is a
closed type that will reject one this release does not model. `src/report.ts` narrows with
`isKnownDeliveryMethod` and routes the rest to `reportVerificationRaw`, so a channel the API gains
after this SDK version stays reportable and the server — not the SDK — judges it:

```text
{"delivery_method":"sms","value":"123456"}          -> {"data":{"delivery_method":"sms","code":"123456"}}
{"delivery_method":"callout","value":"123456"}      -> {"data":{"delivery_method":"callout","code":"123456"}}
{"delivery_method":"whatsapp","value":"123456"}     -> {"data":{"delivery_method":"whatsapp","code":"123456"}}
```

`isKnownDeliveryMethod` decides which method carries the value, not which field goes on the wire.
This handler sends `code` throughout because that is what both modelled channels use and the safe
default for a channel that arrives later; `reportVerificationRaw` would equally accept `cli`, and on
that path the field is the caller's to choose.

## Checks

```sh
npx tsc --noEmit -p examples/node-server/tsconfig.json
npx vitest run --project scripts scripts/node-server-e2e.test.mjs
```

The second boots this server and the mock on ephemeral ports and drives all four callback outcomes
over real sockets, including a bare-origin registration and a deliberately wrong signed path.
