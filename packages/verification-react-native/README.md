# @didww/verification-react-native

`useVerification()` — one hook that drives a whole phone-number verification: start it, hold the
state your screen renders from, submit what the user typed, and on Android read the code out of the
incoming SMS without asking for a permission.

```sh
npm install @didww/verification-react-native
```

[`@didww/verification-core`](../verification-core) comes with it and holds the client, the wire
types and the error tree.

This package ships an Android native module, so it needs a **development build** — `expo run:android`
or an EAS build. In Expo Go it still works, minus SMS auto-capture; see
[Expo Go](#expo-go-and-anywhere-else-the-module-is-absent).

## Authentication on a device

Only `publicAuth` and `basicAuth` are reachable from here. Signed `application` auth lives in the
Node package and cannot be imported into a React Native bundle at all — it needs `node:crypto`,
which Metro cannot resolve.

Use `publicAuth`. **`basicAuth` puts a recoverable secret in your app**: it is sent verbatim on
every request, and anything in a shipped bundle can be read out of it — `__DEV__` is not a
protection, and neither is minification. The SDK logs a warning on the console when it sees a
release build, which is a reminder, not a control.

A `public` start is authorised by a callback to **your** server before the verification is created.
If your application has no callback URL registered, every `public` start comes back already denied
with `denied_missing_callback_url`. See
[the callback gate](../verification-node#implementing-the-callback-endpoint). The alternative is to
give the app no credentials at all and proxy every call through your own backend, which uses signed
`application` auth.

## A screen

```tsx
import { useEffect, useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { VerificationClient, publicAuth } from '@didww/verification-core';
import { otpInputProps, useVerification } from '@didww/verification-react-native';

// Built once, at module scope: a client rebuilt on every render rebuilds its transport too.
const client = new VerificationClient({
  auth: publicAuth('app_public_key'),
  environment: 'sandbox',
});

export function VerifyScreen({ destination }: { destination: string }) {
  const controller = useVerification({ client });
  const { state } = controller;
  const [typed, setTyped] = useState('');

  // A captured code is handed to you, not submitted for you.
  useEffect(() => {
    if (state.kind === 'captured') controller.submit(state.value);
  }, [state, controller]);

  switch (state.kind) {
    case 'idle':
      return (
        <Button
          title="Send code"
          onPress={() => {
            controller.start({
              destination,
              deliveryMethod: 'sms',
              sms: { languages: ['en-US'] },
            });
          }}
        />
      );

    case 'starting':
      return <Text>Sending…</Text>;

    case 'awaitingInput':
      return (
        <View>
          {state.lastError === null ? null : (
            <Text>{state.lastError.detail ?? state.lastError.code}</Text>
          )}
          <TextInput {...otpInputProps} value={typed} onChangeText={setTyped} />
          <Button
            title="Verify"
            onPress={() => {
              controller.submit(typed);
            }}
          />
        </View>
      );

    case 'captured':
      return <Text>Code received automatically…</Text>;

    case 'submitting':
      return <Text>Checking…</Text>;

    case 'verified':
      return <Text>Verified.</Text>;

    case 'failed':
      return (
        <Text>
          {state.reason.source === 'api'
            ? (state.reason.error.detail ?? state.reason.error.code)
            : state.reason.error.code}
        </Text>
      );

    case 'denied':
      return <Text>{state.error?.detail ?? 'This number was not allowed.'}</Text>;

    case 'expired':
      return (
        <Button
          title="Start again"
          onPress={() => {
            controller.reset();
          }}
        />
      );

    case 'setupError':
      return <Text>{`This app is misconfigured: ${state.code}`}</Text>;
  }
}
```

The controller's methods — `start`, `resume`, `resumeById`, `submit`, `reset` — never throw and
never return a promise. Everything you learn arrives through `state`. `submit` is single-flighted, so
a double tap sends one report; calling it before the verification is live buffers the value and
sends it once the start lands. `start` called twice yields `already_running` rather than a second,
billable verification.

## Every state

| `state.kind`    | Terminal | What to render                                                                                          |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `idle`          | no       | the "send me a code" affordance. Nothing has been started.                                              |
| `starting`      | no       | a spinner. No verification exists yet.                                                                  |
| `awaitingInput` | no       | the code field. Carries `destination`, `fee`, `sms`, `expiresAt`, and `lastError`.                      |
| `captured`      | no       | a code arrived from SMS auto-capture and has **not** been submitted. Submit it; show that you did.      |
| `submitting`    | no       | a spinner over the code field. The verification is still alive.                                         |
| `verified`      | **yes**  | success. Carries `verificationId`.                                                                      |
| `failed`        | **yes**  | the failure. Carries `reason`, which says whether the API or the SDK decided it.                        |
| `denied`        | **yes**  | your own callback, or an answer the API could not read, refused this verification. `error` may be null. |
| `expired`       | **yes**  | the verification ran out of time. Offer `reset()` and a fresh start.                                    |
| `setupError`    | **yes**  | **your app is misconfigured** — the user can do nothing. Do not show them a retry button.               |

Terminal means only `reset()` or a fresh `start()` leaves it. Reaching a terminal state also disarms
the SMS listener.

`setupError` is the state for a failure that is yours, not the user's: today it is
`denied_missing_callback_url`, meaning this application started a verification with `public` auth and
has no callback URL registered, so the API had nobody to ask. Retrying the same call cannot succeed.
Log it loudly; show the user something neutral.

`captured` is deliberately not auto-submitted. You may want to show the code you filled in, or run a
check of your own, before it is spent — a report is not idempotent and only three attempts exist.

### Which errors are recoverable

A submit that fails with one of these returns to `awaitingInput` with the error in `lastError`, and
the verification stays alive for another attempt:

`code_invalid`, `cli_invalid`, `code_blank`, `cli_blank`, `code_value_present`, `cli_value_present`,
`delivery_method_invalid`, `validation_failed`, `not_ready_to_report`.

Everything else is terminal. Two absences are deliberate:

- **`too_many_attempts` is not recoverable**, and there is no local attempt counter. Whether another
  attempt is allowed is the server's decision, and it answers `200` with `status: 'failed'` when the
  limit is passed rather than a 4xx.
- **`already_verified` is a failure, not a success.** It is tempting to read it as "fine, that number
  is verified" and let the user in. It means the opposite. The server returns it when the row was
  verified earlier _and this submission was wrong_ — its own wording is "verification is already
  verified; provided value is invalid". A correct value against an already-verified row succeeds
  normally. So treating `already_verified` as success would admit whoever just typed the wrong code.

**Every failure during the start phase is terminal**, including ones that would be recoverable during
submit. The recoverable set presupposes a verification to return to, and while `starting` there is
none.

`failed` carries a `reason` that is either `{ source: 'api', error }` — an error the server produced,
with `code` and `detail` — or `{ source: 'sdk', error }`, which the SDK decided itself:
`already_running` (a second `start()` while one is in flight), `transport` (no response: network
failure, timeout, abort), and `decoding` (a response arrived and was not what this release expects).
The union also declares `superseded`, for in-process supersession; the current hook resolves that by
discarding the stale result rather than surfacing an error, so nothing emits it today. Match on
`source` before you read `code` — the wire has a `superseded` slug of its own, and `source` is what
tells the two apart.

Three codes read oddly and should be translated for your users: `stale_dispatch` is "the dispatch
could not be completed in time", `superseded` is "replaced by a newer verification for the same
number", and `application_deleted` means the application record this verification belonged to was
removed while it was still in flight.

## The code input

```tsx
<TextInput {...otpInputProps} value={typed} onChangeText={setTyped} />
```

`otpInputProps` sets `textContentType`, `autoComplete` and `keyboardType` so both platforms' own
keyboards offer the incoming code. On iOS this is the whole of the auto-fill story: the system
surfaces the code above the keyboard and the user taps it. Nothing else in this package runs on iOS.

## SMS auto-capture on Android

When the channel is `sms` and the native module is present, the hook computes this build's app hash,
sends it with the start, arms the platform SMS Retriever, and — when a matching message arrives —
extracts the code and moves you to `captured`. The user taps nothing. It disarms itself on a terminal
state, when the verification's `expiresAt` passes, and when the server's
`interceptionTimeoutSeconds` budget runs out; that last one is a **budget for the listener, not a
deadline for the user**, and manual entry keeps working until `expiresAt`.

Pass `autoCapture: false` to `useVerification` to turn the whole thing off.

**No SMS permission and no config plugin.** The package's own Android manifest is empty and it
contributes no SMS or call-log permission — not `RECEIVE_SMS`, not `READ_SMS`, not `READ_CALL_LOG` —
and there is nothing to add to `app.json`. It autolinks on install. The platform hands the SDK
exactly one message, the one addressed to this build, and never the user's inbox.

Its dependencies do add entries of their own: a self-scoped
`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, Play Services' `GoogleApiActivity` and version
meta-data, and the AndroidX startup provider. `manifest-probe/manifest-golden.txt` in this
repository is the full list an integrator inherits.

### The app hash

The Retriever will only deliver a message whose last token is an 11-character hash of **your package
name plus the certificate your APK was signed with**. The server appends it to the message body, so
it has to be sent with the start — which the hook does for you.

```tsx
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { getAppHash, isSmsAutoCaptureAvailable } from '@didww/verification-react-native';

export function AppHashScreen() {
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    void getAppHash().then(setHash);
  }, []);

  if (!isSmsAutoCaptureAvailable()) return <Text>Auto-capture cannot run here.</Text>;
  return <Text>{hash ?? 'This build has no readable app hash.'}</Text>;
}
```

`getAppHash()` never rejects. It answers `null` wherever the native module is absent, and
`isSmsAutoCaptureAvailable()` tells you which case you are in.

**The certificate is the part that catches people.** The hash changes when the package name changes
_and_ when the signing certificate changes, so a debug build, a locally signed release, and the build
your users actually install can each have a different one. Under **Play App Signing** the certificate
that signs the delivered artifact is held by the store, not the upload key you hold, so the hash of
the artifact on a device is not the hash of anything you can build locally. Read it off an installed
build — that screen above is why it exists.

**A wrong hash is completely silent.** The SMS arrives, the Retriever does not fire, nothing throws,
nothing is logged in a release build, and the user types the code by hand as if the feature were
never there. There is one guard: the server echoes the hash it stored, and if that echo does not
equal what was sent the listener declines to arm and warns — but only in a development build, and
only for that failure. A hash that is well-formed, accepted, stored and echoed, and simply belongs to
a different build than the one running, produces no signal at all. Manual entry always works, so the
worst case is a missing convenience you never notice.

### Expo Go, and anywhere else the module is absent

`getAppHash()` returns `null`, `isSmsAutoCaptureAvailable()` returns `false`, no hash is sent, no
listener is armed, and the verification runs normally with manual entry. This is the case on iOS, in
Expo Go — where a native module cannot be linked, ever — and in a bare React Native app without Expo
Modules. It is not an error and nothing needs handling; the availability check is there so you can
tell the user what to expect. Note the check is module presence, not `Platform.OS === 'android'`: on
Android in Expo Go the platform says "android" while capture is impossible.

### What has been observed, and what has not

Auto-capture is the part of this SDK with the largest gap between "tested" and "proven in the field",
and the failure is silent, so here is exactly where the line is.

**Observed:**

- The app-hash algorithm agrees with a constant derived from the platform vendor's own reference
  helper, computed outside this codebase.
- That computation runs on a real Android emulator against a real signing certificate and produces a
  well-formed 11-character hash.
- The Retriever fires on a Play-Store-image emulator for an injected message carrying the correct
  hash. The wrong-hash control produced nothing, so the match is doing the work.

**Not observed:**

- That the platform delivers to a build signed by **Play App Signing**, whose certificate differs
  from any locally generated one. This is the configuration most production apps ship in.
- That a real platform-originated verification message arrives in the expected form.

What to do about it: before you rely on auto-capture, install a Play-signed build — an internal
testing track is enough — put a screen like the one above in it so you can see the hash the running
build reports, and run one real verification end to end. If the code fills itself in, the
Play-signed path works for your app. An installed build is the only place that hash can be read, and
that verification is the only place the path can be confirmed. Nothing degrades if it is wrong:
manual entry still works, the feature is simply absent, and nothing will tell you.

## Call-out

`callout` — a spoken code over a voice call — behaves exactly like `sms` from your side: the user
hears a code and types it.

```ts
controller.start({ destination, deliveryMethod: 'callout' });
controller.submit(codeTheUserHeard);
```

There is no auto-capture on this channel: a spoken code never reaches the device as text, so the
user types it and `submit()` sends it as `code`.

`submit()` always sends `code` — for both channels above, and for a channel the API gains after this
release, which is the field it will almost certainly want. A channel that expects some other field
is not reportable through the hook: call `client.reportVerificationRaw(id, { deliveryMethod, cli })`
yourself, where the field is yours to pick and only the server judges the pairing.

## Language

Both `sms` and `callout` take a preference list, in a block named after the channel:

```ts
controller.start({ destination, deliveryMethod: 'callout', callout: { languages: ['pt-PT'] } });
```

Tags are tried in order and fall back to `en-US`; include the region subtag. Each channel resolves
against its own catalogue — the tags with a template are not the tags with a recording — so read
back what the server chose rather than assuming it honoured the first preference:

```ts
if (state.kind === 'awaitingInput') {
  const chosen = state.callout?.language ?? state.sms?.language;
}
```

The supported tags are server-side data and change without an SDK release, so no list ships here.

## Resuming

```ts
controller.resume({ destination: '+12025550143', deliveryMethod: 'sms' });
controller.resumeById({ verificationId: 'ver-1', deliveryMethod: 'sms' });
```

`resume` reattaches to the newest verification for a number; `resumeById` reattaches to one your app
persisted across a restart. Both land in whatever state that verification is actually in — including
a terminal one — rather than starting anything new.

## License

MIT.
