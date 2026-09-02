# @didww/verification-node

Node.js bindings for the DIDWW Verification API: signed `application` auth, and the inbound
callback endpoint that decides whether a verification is allowed to start.

```sh
npm install @didww/verification-node
```

[`@didww/verification-core`](../verification-core) comes with it, and holds the client itself, the
wire types and the error tree. Read that first; this package adds the two things that need a
server.

## Signed `application` auth

```ts
import { VerificationClient } from '@didww/verification-core';
import { applicationAuth } from '@didww/verification-node';

const client = new VerificationClient({
  auth: applicationAuth({
    key: process.env.DIDWW_APPLICATION_KEY!,
    secret: process.env.DIDWW_APPLICATION_SECRET!,
  }),
});
```

The secret never goes on the wire. Each request carries
`Authorization: Application <key>:<signature>` and an `x-timestamp` header, both derived from one
reading of the clock — deriving the timestamp twice races across a second boundary and produces a
401 with a valid signature on both sides.

A start signed this way is never put to the callback gate: the caller is already trusted.

### The secret is URL-safe base64, and it is decoded before use

The HMAC key is the _bytes_ the secret decodes to, never its characters. `applicationAuth` and
`Signer` both reject anything that is not canonical URL-safe base64 at construction, with a
`ConfigurationError` naming the cause:

- characters outside `A–Z a–z 0–9 - _` — in particular `+` and `/`, the standard alphabet, which is
  the likeliest paste error
- `=` anywhere but the trailing padding, or padding of the wrong length
- a non-canonical tail, whose final character carries non-zero unused bits. Node's decoder silently
  normalises this, so `…_AB` would become `…_AA` and every later signature would use a key the
  server never issued.

A key containing `":"` is refused too: the server splits `Application <key>:<signature>` on the
first colon, so the tail of the key would be read as the signature.

### What is signed

Five lines joined with `"\n"`, with no trailing newline:

```
<HTTP-METHOD>
<CONTENT-MD5>
<CONTENT-TYPE>
x-timestamp:<TIMESTAMP>
<PATH>
```

- `CONTENT-MD5` is standard base64 of the MD5 of the body bytes, and the **empty string** when
  there is no body.
- `CONTENT-TYPE` is the exact `Content-Type` header value sent, and the **empty string when no
  such header is sent**. A bodyless request must send no `Content-Type` at all. This is the one
  that bites: a transport that helpfully defaults a content type on every request 401s every signed
  `GET`, and no test that runs the client against its own signer can see it, because the two agree
  with each other while both disagree with the server. `fetchTransport` refuses to send such a
  request.
- `PATH` is the request-target path, undecoded, query excluded, byte-identical to the path in the
  request line. Percent-encoded segments stay percent-encoded.
- `TIMESTAMP` is Unix epoch **seconds** as a decimal string, the same value that goes in the
  header. The server's replay window is **300 seconds** either side of its own clock; outside it, or
  unparseable, is 401.

`Signer.stringToSign()` is public so you can print it and diff it against the server when a
production signature mismatches:

```ts
import { Signer } from '@didww/verification-node';

const signer = new Signer(process.env.DIDWW_APPLICATION_SECRET!);
const input = {
  method: 'GET',
  path: '/api/v1/verifications/ver-1',
  contentType: '', // no body, so no Content-Type header and an empty line here
  body: '',
  timestamp: '1767225600',
};

console.log(JSON.stringify(signer.stringToSign(input)));
console.log(signer.sign(input));
```

## Implementing the callback endpoint

When a device starts a verification with `public` or `basic` auth, the API asks your server whether
to go ahead, and waits for the answer before creating the verification. Until this endpoint answers
correctly, **every such verification is denied**. [`docs/callbacks.md`](../../docs/callbacks.md) is
the full reference: the exact string that is signed, the order rejections are decided in, and the
traps a bare-origin callback URL sets.

```ts
import express from 'express';
import { expressCallbackHandler } from '@didww/verification-node';

const secrets = new Map<string, string>([['app_live_key', process.env.DIDWW_APPLICATION_SECRET!]]);

const app = express();

app.post(
  '/callbacks/didww',
  // Required. The signature covers the exact received bytes; a body re-serialized by
  // express.json() is not them, and the handler refuses to guess.
  express.raw({ type: '*/*' }),
  expressCallbackHandler({
    // The path of the REGISTERED callback URL, query excluded — never the path this request
    // arrived on. A registered `https://example.com` signs the empty string: `path: ''`.
    path: '/callbacks/didww',

    // A resolver, not a fixed string: one endpoint may serve several applications. `null` is
    // what makes a key unknown.
    secret: (key) => secrets.get(key) ?? null,

    // Runs only after the signature verifies. Return exactly one of these two.
    decide: (payload) => {
      const blocked = payload.data.destination.startsWith('1900');
      return { action: blocked ? 'deny' : 'allow' };
    },

    // Log why a callback was refused. The reply itself carries no reason.
    onRejected: (reason) => {
      console.warn(`callback rejected: ${reason}`);
    },
  }),
);

app.listen(3000);
```

Five things about this, each of which can deny 100% of your verifications while both sides hold
perfectly valid signatures.

**`express.raw({ type: '*/*' })` is a requirement, not a suggestion**, and it is mounted on that
route alone — never globally, or the rest of your API stops parsing JSON. The signature covers the
bytes as received; a body that went through `express.json()` and was re-serialized differs in
whitespace and key order, and will not verify. The handler throws `ConfigurationError` rather than
guessing, but only once a callback actually arrives.

**`path` is required and is the registered URL's path**, because that is what the API signs — a
property of the registration, not of the request:

| Registered callback URL        | `path`                |
| ------------------------------ | --------------------- |
| `https://example.com/cb/didww` | `'/cb/didww'`         |
| `https://example.com`          | `''` — **not** `'/'`  |
| `https://example.com?x=1`      | `''` — query excluded |

A bare origin signs the **empty string**. An endpoint that assumes `'/'` there computes a valid
signature over the wrong string, mismatches every single time, and denies every verification for
that application — and nobody guesses `''`. The two also part company whenever a proxy or ingress
rewrites the path before your server sees it: the registered URL is `/cb/didww` and your handler is
mounted at `/didww`. That is the other reason this is never read off the request.

If you genuinely want the received pathname, pass the literal `'incoming'`, so the choice is visible
at the call site. In that mode `/` and `''` are both tried, since they describe the same registered
URL.

**`secret` is a resolver.** One endpoint may serve several applications; the key arrives in each
callback's `Authorization` header and is passed to your function. Return `null` for a key you do
not know — that, and only that, is what makes it unknown. Returning a blank string is treated as a
misconfigured store and throws, rather than answering 401 to a legitimate application forever. A
fixed string is accepted too, and is decoded at wiring time so a malformed one fails at startup.

**The answer decides the verification, once.** A `2xx` must **carry** `{"action":"allow"}` or
`{"action":"deny"}` in the body. Everything else denies the verification: any non-2xx status
whatever the body, a 2xx body that is not JSON, a 2xx whose `action` is neither value or absent, a
response over 8 KiB, a connection failure, a timeout. **Nothing is retried** — one request, one
answer. An empty `200` is a denial, not an acknowledgement. A denial arrives at the customer as
`denied_by_callback` when you said so, and `denied_invalid_callback_response` when the API could not
read your answer.

**Never echo the rejection reason.** The handler replies with a bare status and no body on purpose.
`unknown_key` is decided before the signature is checked, so a response that named it would answer
"is this application key real?" to anyone who asks — an oracle for enumerating your keys.
`onRejected` exists so the reason reaches your logs instead: `missing_signature`,
`missing_timestamp`, `timestamp_out_of_window`, `unknown_key`, `signature_mismatch`,
`body_too_large`, `unparseable_body`. The first five answer 401 and the last two 400.

Other details: the timestamp tolerance defaults to **300 seconds** and is settable with `tolerance`.
Inbound bodies over **8 KiB** are rejected before anything is hashed — this is a bound of our own on
unauthenticated work, and is not the API's read limit on your reply, which happens to be the same
size. On `{ ok: true }` the payload carries `event`, the `key` the request authenticated as, and
`data.id` / `data.destination` / `data.deliveryMethod`.

### Without Express

`CallbackVerifier` is the same logic with no framework attached. You supply the wire values; it
answers with a discriminated result.

```ts
import { CallbackVerifier } from '@didww/verification-node';

const verifier = new CallbackVerifier({
  secret: (key) => lookupSecret(key),
  tolerance: 300, // seconds either side of now; this is the default
});

const result = await verifier.verify({
  method: 'POST',
  path: '/callbacks/didww', // the registered URL's path
  contentType: headers['content-type'] ?? '',
  body: rawBody, // the exact received bytes
  timestamp: headers['x-timestamp'],
  authorization: headers['authorization'],
});

if (result.ok) {
  console.log(result.payload.key, result.payload.data.id, result.payload.data.deliveryMethod);
} else {
  console.warn(result.reason, result.key); // log it; do not answer with it
}
```

Writing the response — status, and a body carrying `action` — is then yours, under the same rules
as above.

## Retrying, and not retrying

**Never auto-retry a report.** It is not idempotent, and only three attempts exist per verification;
a retry burns one of them, and the fourth answers `200` with `status: 'failed'` and
`error_code: 'too_many_attempts'` — not a 4xx. Never auto-retry a start either: a second start
supersedes the first, and both are billed.

When a start times out, **ask instead of re-sending**:

```ts
import { isDidwwError } from '@didww/verification-core';

try {
  await client.startVerification({ destination, deliveryMethod: 'sms' });
} catch (error) {
  if (isDidwwError(error) && error.name === 'TransportError') {
    // The start may still have landed. Ask, never re-send: a second start supersedes the first
    // and is billed again.
    const existing = await client.getVerificationByNumber(destination);
    console.log(existing.id, existing.status);
  } else {
    throw error;
  }
}
```

`getVerificationByNumber` returns the newest verification for that number, finished ones included,
so it tells you whether the start you lost the response to actually happened. The SDK retries `GET`
for you, and only `GET`.

## `PUT`, not `PATCH`

Reports are sent with `PUT`. The API accepts either verb on the report routes — they are one
operation, not two — but the verb is inside the signed string, so it has to be pinned rather than
left implicit. The Ruby SDK for this API pins `PATCH`; both mobile SDKs pin `PUT`, and so does this
one. If you are comparing captured traffic between SDKs, that is the difference you are looking at.

## License

MIT.
