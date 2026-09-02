# DIDWW Verification SDK for JavaScript

Confirm that a user controls a phone number. The API delivers a one-time challenge over SMS or a
voice call; your code starts the verification and reports back the code the user supplied.

Three packages. Install the one that matches where your code runs.

| Package                                                                  | Install it in          | Gives you                                                                                      |
| ------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------- |
| [`@didww/verification-core`](packages/verification-core)                 | any JavaScript runtime | the client, the wire types, `basic` and `public` auth. No runtime dependencies.                |
| [`@didww/verification-node`](packages/verification-node)                 | a Node.js server       | signed `application` auth, and the inbound callback gate that allows or denies a verification. |
| [`@didww/verification-react-native`](packages/verification-react-native) | a React Native app     | `useVerification()`, and Android SMS auto-fill.                                                |

`verification-node` and `verification-react-native` both depend on `verification-core`, so
installing either brings it with it.

## Which auth mode goes where

| Mode          | Credential                            | Where it may be used                               | Package                    |
| ------------- | ------------------------------------- | -------------------------------------------------- | -------------------------- |
| `application` | key + secret, HMAC-signed per request | server only — the secret must never ship in an app | `@didww/verification-node` |
| `basic`       | key + secret sent verbatim            | server only                                        | `@didww/verification-core` |
| `public`      | key only                              | a mobile or browser client                         | `@didww/verification-core` |

`basic` and `application` both prove possession of the secret, so both are confined to a server:
anything shipped to a device is recoverable from the bundle, and `application` is the only one that
never puts the secret on the wire at all. `public` sends a key that is an identifier rather than a
secret, which is why it is safe on a device — and why it is not, on its own, authorisation. A start
made with `public` or `basic` is put to your own server first, over the
[callback gate](packages/verification-node#implementing-the-callback-endpoint); a start signed with
`application` is already trusted and is never gated.

So a mobile app either talks to the API directly with `public` auth and answers the callback from
your backend, or proxies every call through your backend, which uses `application`.

Each application also carries a minimum scheme, ranked `public` < `basic` < `application`. A
request below it is rejected with 401.

## Quick start

```ts
import { VerificationClient, basicAuth } from '@didww/verification-core';

const client = new VerificationClient({
  auth: basicAuth(process.env.DIDWW_KEY!, process.env.DIDWW_SECRET!),
  environment: 'sandbox',
});

const started = await client.startVerification({
  destination: '+12025550143',
  deliveryMethod: 'sms',
});

const result = await client.reportVerification(started.id, {
  deliveryMethod: 'sms',
  code: '123456',
});

console.log(result.status); // 'verified' | 'failed' | 'expired' | 'denied' | 'pending'
```

## Examples

Runnable, in `examples/`:

- **`mock-api`** — an in-memory stand-in for the API, so the rest runs with no credentials and no
  publicly reachable URL. `npm start --prefix examples/mock-api`
- **`node-server`** — an Express backend: a start/report proxy over signed `application` auth, and
  the inbound callback gate. `npm start --prefix examples/node-server`
- **`expo-app`** — an Expo app over `useVerification()`, with a branch for every state and the app
  hash read off the running build. `npm start --prefix examples/expo-app`

## Elsewhere

- [Verification API documentation](https://doc.didww.com/otp-verification/index.html)

Other SDKs for the same API, each in its own repository:

- [Android SDK](https://github.com/didww/didww-verification-android-sdk) — Kotlin
- [iOS SDK](https://github.com/didww/didww-verification-ios-sdk) — Swift
- [Ruby SDK](https://github.com/didww/didww-verification-ruby-sdk)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
