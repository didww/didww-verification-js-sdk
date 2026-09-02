# @didww/verification-core

The runtime-agnostic client for the DIDWW Verification API: start a verification, report the value
the user supplied, poll for the outcome. Runs anywhere there is a `fetch` — Node, a browser, React
Native, an edge runtime.

```sh
npm install @didww/verification-core
```

On a Node server, install [`@didww/verification-node`](../verification-node) instead — it brings
this package with it and adds signed `application` auth and the inbound callback gate. In a React
Native app, install [`@didww/verification-react-native`](../verification-react-native).

## Authentication

Two modes live here. The third, signed `application` auth, is in the Node package, because signing
needs a secret that must never reach a device.

```ts
import { VerificationClient, basicAuth, publicAuth } from '@didww/verification-core';

// On a server: the secret is sent verbatim, base64-encoded, on every request.
const server = new VerificationClient({ auth: basicAuth('app_key', 'app_secret') });

// On a device: the key is an identifier, not a secret.
const device = new VerificationClient({ auth: publicAuth('app_key') });
```

`basicAuth` is server-only. The secret it sends is recoverable from anything it ships in; in a
React Native release build the SDK warns about this on the console, but the warning is not a
control. Use `publicAuth` on a device.

Both throw `ConfigurationError` at construction — not on the first request — for a blank credential
or a key containing `":"`. The server splits on the first colon in both schemes, so a key with one
in it silently becomes a different credential.

A start authenticated with `public` or `basic` is authorised by a callback to your own server
before it is created. If your application has no callback URL registered, a `public` start comes
back already denied with `denied_missing_callback_url`. See
[the callback gate](../verification-node#implementing-the-callback-endpoint).

## `environment` versus `baseUrl`

```ts
new VerificationClient({ auth }); // https://verification.didww.com
new VerificationClient({ auth, environment: 'sandbox' });
new VerificationClient({ auth, environment: 'sandbox', baseUrl: 'http://127.0.0.1:4000' }); // baseUrl wins
```

`environment` selects one of two published hosts and defaults to `'production'`. `baseUrl` is an
absolute URL that overrides it, for a mock or a proxy; a path on it is used as a prefix. It is
validated at construction, and a `baseUrl` that is not a valid absolute URL throws
`ConfigurationError`.

Other `ClientOptions`: `transport`, `timeoutMs` (default 30000), `retry`, `userAgent`, `logger`,
`keepRawPayload`.

## The methods

```ts
await client.startVerification({ destination, deliveryMethod: 'sms' });
await client.getVerification(id);
await client.getVerificationByNumber(destination);
await client.reportVerification(id, { deliveryMethod: 'sms', code: '123456' });
await client.reportVerificationByNumber(destination, {
  deliveryMethod: 'callout',
  code: '123456',
});

// The escape hatch: a channel this release does not model. No client-side guard runs.
await client.reportVerificationRaw(id, { deliveryMethod: 'whatsapp', code: '123456' });
await client.reportVerificationRawByNumber(destination, {
  deliveryMethod: 'whatsapp',
  code: '123456',
});
```

Every method is `async`, including the ones whose guards fail before a request is issued, so a
caller that only wrote `.catch` never sees a synchronous throw.

`ReportOptions` is closed: `sms` and `callout` are the channels this release models and both are
reported with `code`, so `cli?: never` stops the wrong field compiling. Supplying it anyway from
plain JavaScript throws `ChannelMismatchError` before the request. `reportVerificationRaw` is the
deliberate way out, and it is separately named so it shows up in review and in a code search.

The `*ByNumber` variants address the **newest** verification for a number, finished ones included.
The number is reduced to ASCII digits before it goes in the path.

**Only `GET` is retried.** The default policy is two attempts with jittered backoff, on a transport
failure or a 5xx. A start or a report that timed out may still have landed on the server, so
retrying one double-charges and supersedes; the retry lives at the single call site that is a `GET`
by construction, and no `retry` policy you pass can reach the others. When a start times out, call
`getVerificationByNumber` instead of re-sending it.

### Narrowing an open `deliveryMethod`

A decoded `deliveryMethod` is an open string — a channel the API gains after this release arrives
as a new value, not as an error — so the closed `ReportOptions` may reject one you are holding.
This is the recipe: narrow the known channels into it, and route the rest to the escape hatch.

```ts
import {
  isKnownDeliveryMethod,
  type VerificationClient,
  type VerificationResult,
} from '@didww/verification-core';

function report(
  client: VerificationClient,
  id: string,
  method: string,
  value: string,
): Promise<VerificationResult> {
  return isKnownDeliveryMethod(method)
    ? client.reportVerification(id, { deliveryMethod: method, code: value })
    : client.reportVerificationRaw(id, { deliveryMethod: method, code: value });
}
```

This recipe sends `code` for everything, because `code` is the field both modelled channels use and
the safe default for a channel that arrives later. It is a default, not a rule: `RawReportOptions`
carries `code` and `cli`, and on the raw path the field is the caller's to choose — the server is the
only thing that judges the pairing. What the guard decides is which method carries the value:
`reportVerification` checks the channel before sending, `reportVerificationRaw` sends what you hand
it.

`expectsCode` is that guard: `true` for a channel reported with a code, `undefined` for one this
release does not model. The `undefined` is the point — it is what lets a channel added after this
release through untouched instead of rejecting it.

## Choosing a language

```ts
await client.startVerification({
  destination: '+351912345678',
  deliveryMethod: 'sms',
  sms: { languages: ['pt-PT', 'en-US'] },
});

await client.startVerification({
  destination: '+351912345678',
  deliveryMethod: 'callout',
  callout: { languages: ['pt-PT', 'en-US'] },
});
```

Options travel in a block named after the channel, and only the block matching `deliveryMethod` is
sent — supplying both is harmless. `languages` is the only member of either.

Tags are tried in order and the first that matches wins, falling back to `en-US`. Include the
region subtag: a bare primary subtag such as `'pt'` passes validation and then silently falls back,
because lookup is on the exact canonical tag.

**Each channel resolves against its own catalogue.** The tags with an SMS template are not the tags
with an announcement recording, so the same list can resolve differently per channel — which is why
the response names the tag actually used:

```ts
const v = await client.startVerification({
  destination: '+351912345678',
  deliveryMethod: 'callout',
  callout: { languages: ['ka-GE'] },
});

v.callout?.language; // 'en-US' — no recording for ka-GE, so it fell back
```

`sms.language` says the same thing for the SMS channel. Both are `null` on a verification stored
before the server began recording one. The supported tags are server-side data and change without
an SDK release, so this package hardcodes no list; the API reference carries the current one.

**`app_hash` is not in `SmsOptions`, on purpose.** It identifies the _running build_, so it cannot
be a value your code writes down: the hash of a debug build, a locally signed build and a
store-distributed build all differ. The React Native package computes it on the device and hands it
to the request builder through an internal channel. Nothing else needs it, and a hash that is
merely wrong-looking fails the whole verification with `app_hash_invalid` rather than being
ignored — so this package validates whatever reaches it and throws `ConfigurationError` before
issuing a request.

## Reading a verification

```ts
import { isPending, type Verification } from '@didww/verification-core';

function render(v: Verification): string {
  if (isPending(v)) {
    const budget = v.sms?.interceptionTimeoutSeconds ?? null;
    return budget === null ? 'waiting' : `listening for up to ${String(budget)}s`;
  }
  if (v.status === 'verified') return `verified — quoted ${v.fee ?? 'nothing'}`;
  return `${v.status}: ${v.errorCode ?? 'no code'} (${v.errorDetail ?? ''})`;
}
```

`isPending` is the condition to poll on; `isFinished` is its exact complement, so a status this
release does not model reads as finished and a `while (!isFinished(v))` loop terminates rather than
spinning forever.

**`fee` is a decimal string, never a number.** `Number()` on it is a rounding bug in a billing
display. It is also a **quote, not a charge**: it is billed only on a verified outcome, and the
message or call itself is billed separately as ordinary traffic.

**`status: 'expired'` is synthesised on read.** The server returns it when the row is unfinished and
past its deadline, with `errorCode: 'expired'` attached, even though nothing was written. A poll can
therefore reach `expired` without any state change having occurred.

`sms` is non-null exactly when `deliveryMethod` is `'sms'`:

- `template` — the message body with the code placeholder (`{{CODE}}`) left unsubstituted. Split a
  received message on it to recover the code.
- `interceptionTimeoutSeconds` — **a budget, not a deadline**. It is how long to keep an on-device
  listener armed, not how long the user has. Manual entry keeps working until `expiresAt`, so never
  fail a verification because this ran out.
- `appHash` — echoed back only when one was stored. Equality with what was sent is the only
  confirmation the server accepted it.

`expiresAt` is a `Date` or `null`, decoded from a strict ISO-8601 check rather than bare
`new Date()`, which reads `"2026"` and `"25 Aug 2026"` as confident wrong instants and rolls
`"2026-02-30"` into March.

`errorDetail` is fixed prose selected by `errorCode`. Display it; switch on the code, never parse
the prose.

## Errors

```
DidwwError
├── ConfigurationError    the SDK was set up wrong. Never a server response.
├── ChannelMismatchError  a report carried the wrong value field for the channel
├── TransportError        no response was obtained: network failure, timeout, abort
├── DecodingError         a response arrived, and its body was not what this release expects
└── ApiError              the API produced an error response, and it decoded
    ├── ValidationError            400, 422
    ├── UnauthorizedError          401
    ├── BalanceInsufficientError   402
    ├── NotFoundError              404
    └── ServerError                5xx
```

A status this release does not model yields a plain `ApiError` rather than a throw or a
neighbouring subclass, so an unforeseen status still reaches you with its envelope attached.

`ApiError` carries `status`, `errors` (one item per failing field, in wire order), `code` (the
first item's code, or `null` — an envelope is not guaranteed to be non-empty), `codes`, and the
undecoded `responseBody`, which is what you have when an ingress answered with HTML that was never
this API's envelope.

**Use `isApiError` and `isDidwwError`, not `instanceof`.** Two copies of this package can be
installed side by side — a dependency whose range excludes the version your app resolves, whether a
stranded older major or a narrower pin, puts them there — and each copy has its own class objects,
so `instanceof` against the wrong one is silently false. The guards test a `Symbol.for` brand, which
is the same symbol in every copy.

```ts
import { isApiError, isDidwwError, isKnownApiErrorCode } from '@didww/verification-core';

try {
  await client.reportVerification(id, { deliveryMethod: 'sms', code: '123456' });
} catch (error) {
  if (isApiError(error)) {
    const first = error.errors[0];
    if (first !== undefined && isKnownApiErrorCode(first.code)) {
      switch (first.code) {
        case 'code_invalid':
          console.log('wrong code — the user may try again');
          break;
        case 'too_many_attempts':
          console.log('no attempts left on this verification');
          break;
        default:
          console.log(first.code, first.detail);
      }
    }
    console.log(error.status, error.codes.join(', '));
  } else if (isDidwwError(error)) {
    console.log(error.name, error.message); // TransportError, DecodingError, ConfigurationError…
  } else {
    throw error;
  }
}
```

`isKnownApiErrorCode` narrows to the closed set so a `switch` over it is exhaustive; codes outside
it pass through as received rather than being flattened into a fallback.

Three outcome codes read oddly on the wire and are worth translating for your users:

| Code                  | What happened                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `stale_dispatch`      | the dispatch could not be completed in time                                                   |
| `superseded`          | replaced by a newer verification for the same number                                          |
| `application_deleted` | the application record this verification belonged to was removed while it was still in flight |

## Substituting the transport and the auth

Both seams are one interface each, and both are how you test without a network.

```ts
import {
  fetchTransport,
  type AuthProvider,
  type AuthRequest,
  type Transport,
} from '@didww/verification-core';

// A Transport is one function. Wrap the built-in one rather than reimplementing it.
const inner = fetchTransport({ timeoutMs: 10_000 });
const traced: Transport = async (request) => {
  const response = await inner(request);
  console.log(request.method, request.path, response.status);
  return response;
};

// An AuthProvider returns authentication headers and nothing else.
const fromVault: AuthProvider = {
  async headers(request: AuthRequest) {
    return { Authorization: await sign(request) };
  },
};
```

A `Transport` receives the exact bytes and headers to send and must alter neither. A request with no
body carries **no** `Content-Type` header at all, and one with a body always carries it: the server
signs the header value it received, so a transport that helpfully defaults a content type rejects
every signed request with 401. `fetchTransport` refuses both mismatches rather than sending them.

An `AuthProvider` must return authentication headers only. One that returns a `Content-Type` is
refused with `ConfigurationError`, for the same reason: the content type is signed, so one supplied
here is not the one the signature covers.

A non-2xx response is an ordinary `HttpResponse`. Only a failure to obtain a response throws, as a
`TransportError`.

## `@didww/verification-core/testing`

A scripted transport double. Request N consumes script entry N — a fixed response or a function of
the request — and every request is recorded verbatim and in order. Calling past the end of the
script throws rather than returning a default, because an extra request is usually the bug the test
exists to catch.

```ts
import { VerificationClient, publicAuth } from '@didww/verification-core';
import { fakeTransport } from '@didww/verification-core/testing';

const body = JSON.stringify({
  data: {
    id: 'ver-1',
    destination: '12025550143',
    delivery_method: 'sms',
    fee: '0.0450',
    status: 'pending',
    error_code: null,
    error_detail: null,
    expires_at: '2026-01-01T00:00:00Z',
    sms: {
      template: 'Your code is {{CODE}}',
      language: 'en-US',
      interception_timeout: 120,
      app_hash: null,
    },
  },
});

const { transport, requests } = fakeTransport([{ status: 201, headers: {}, body }]);
const client = new VerificationClient({ auth: publicAuth('app_key'), transport });

await client.startVerification({ destination: '+12025550143', deliveryMethod: 'sms' });

console.log(requests[0]?.method); // 'POST'
console.log(requests[0]?.path); // '/api/v1/verifications'
console.log(requests[0]?.body); // the exact bytes sent
```

## No dependencies

This package has none — not runtime, not optional, not peer. It uses `fetch`, `AbortController`,
`URL` and `JSON`, all of which the target runtimes already provide, and no Node builtin, so the same
build works in React Native and at the edge.

Check it yourself after installing:

```sh
node -e "const p=require('@didww/verification-core/package.json');console.log(Object.keys(p).filter(k=>/dependencies/i.test(k)))"
# []
```

In this repository the same claim is enforced three ways by `npm run check:zero-deps`: the manifest
declares no dependency key, the resolved production subtree is empty, and the packed tarball
installs into an empty project as exactly one package.

## License

MIT.
