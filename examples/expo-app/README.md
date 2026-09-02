# Expo example app

Three screens over `@didww/verification-react-native`:

| Screen             | What it shows                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `app/index.tsx`    | destination input and a channel picker for `sms` and `callout`                           |
| `app/verify.tsx`   | `useVerification()` — a branch for **every** state in the union, not just the happy path |
| `app/app-hash.tsx` | `getAppHash()` read off the running build, and what `null` means                         |

Navigation is a `useState` switch in `App.tsx`; there is no router dependency, which keeps
`expo prebuild` down to what the SDK itself needs.

## Install

This app is **not** an npm workspace member and has its own `node_modules`. Install inside it, never
from the repository root:

```sh
npm run build                      # from the repository root: the SDK is consumed as built output
npm ci --prefix examples/expo-app  # or `npm install` in this directory
```

`@didww/verification-core` and `@didww/verification-react-native` are `file:` dependencies, so npm
symlinks them from `../../packages` and every change to the SDK needs a root `npm run build` before
it is visible here.

### The versions are pinned on purpose

`react-native` is pinned to **0.86.2** exactly, and `overrides` holds the whole tree to it. React
Native 0.87's Android Gradle plugin requires Gradle >= 9.4.1, and Gradle 9.4.1 bundles a Kotlin
2.3.0 stdlib that Expo SDK 57's settings plugin cannot compile against. The two are mutually
exclusive; 0.86.2 is the pair that builds. Anything that drags 0.87 into this tree breaks the
Android build for the whole repository. `expo`, `expo-modules-core` and `react` are pinned to the
same versions the repository root uses for the same reason.

`metro.config.js` pins module resolution to this app's `node_modules`
(`disableHierarchicalLookup`). Without it Metro follows the SDK symlink to its real path, climbs to
the repository root and loads a second copy of React, which breaks every hook.

## Running it

Start the mock API on the host machine, then the app:

```sh
npm start --prefix examples/mock-api   # listens on 127.0.0.1:4000
cp examples/expo-app/.env.example examples/expo-app/.env
npm start --prefix examples/expo-app
```

**The device is not the host machine.** The Android emulator reaches the host at
`http://10.0.2.2:<port>`; the iOS simulator reaches it at `http://localhost:<port>`. `127.0.0.1`, as
printed by the mock API when it boots, is the device itself on both — the request fails with a
connection error and nothing says why. `src/config.ts` picks the right default per platform;
`EXPO_PUBLIC_BASE_URL` overrides it.

Expo inlines `EXPO_PUBLIC_*` variables at bundle time, so a change to `.env` needs the bundler
restarted, not reloaded. Plain `http` also needs a debug build on Android: release builds block
cleartext traffic.

SMS auto-capture needs a development build (`npm run android --prefix examples/expo-app`). In Expo
Go the native module can never be linked, so the code is typed by hand — which is the fallback the
SDK is designed around, not a failure.

## Authentication

Only two of the API's three schemes can run on a device, and this app implements both:

- **`publicAuth`** sends the application key, which is an identifier rather than a secret. This is
  what a shipped app uses. The server decides each start by calling your registered callback URL.
- **`basicAuth`** sends the application secret with every request. Anything in a shipped bundle is
  recoverable from it, so this belongs on a server you control — it is here only because it is the
  one scheme that completes a verification against the mock with nothing else running. The home
  screen says so on screen while it is active.

**`application` auth is deliberately absent.** It signs every request with the application secret, which
cannot be held on a device; it lives in the Node package instead.

`EXPO_PUBLIC_AUTH_MODE` selects between the two. Against the mock API, the seeded applications
produce different outcomes, which is a cheap way to reach the states a happy path never shows:

| `EXPO_PUBLIC_APPLICATION_KEY` | Mode     | Result                                                                                |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `app_basic`                   | `basic`  | `awaitingInput` — the default; code `123456`                                          |
| `app_public_callback`         | `public` | `denied` (`denied_invalid_callback_response`) unless a callback receiver is listening |
| `app_public_no_callback`      | `public` | `setupError` (`denied_missing_callback_url`)                                          |

Secrets for the seeded applications are printed by the mock API on boot.

## The app-hash screen is not decoration

The hash is derived from the certificate the build is **actually signed with**. Play App Signing
re-signs an uploaded artifact with a different key, so the hash of the build users install is not
the hash of the build you uploaded. A mismatch is completely silent: the message still arrives,
nothing fires, and manual entry still works. Reading the value off the running build is the only way
anyone diagnoses it — hence the screen.

`getAppHash()` resolves `null` on iOS, in Expo Go, and in a bare app without Expo Modules. That is
not an error: auto-capture is simply off. The screen says so when it happens.

## What the verify screen covers

`idle`, `starting`, `awaitingInput`, `captured`, `submitting`, `verified`, `failed`, `denied`,
`expired`, `setupError` — every member of `VerificationState`, each with its own branch. A missing
one is a type error, not a blank screen: the `default` case feeds the state to a `never` parameter.

"Reload from server" on the `awaitingInput` card calls `resume()`, which re-reads the newest
verification for the number. That is how `expired` is reached: the server synthesises it on read for
a row that ran out of time, and nothing is written when it does.

`awaitingInput.lastError` gets its own notice. It is the recoverable path and the most visible
behaviour of the hook: a wrong code returns to `awaitingInput` carrying the error rather than ending
the verification, and the same row accepts another value.

## Checks

```sh
npm run typecheck --prefix examples/expo-app   # tsconfig.json extends ../../tsconfig.base.json
```

Lint and formatting run from the repository root (`npm run lint`, `npm run format:check`) — this
directory is covered by both.
