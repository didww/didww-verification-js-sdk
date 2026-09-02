# Contributing

## Requirements

- Node.js 22 or newer (`.nvmrc` pins 22; CI runs 22 and 24)
- A JDK 17 and an Android SDK, for the Android half of the React Native package. Gradle finds
  the JDK itself through a toolchain; it does not have to be `JAVA_HOME`.

## Commands

| Command                | Does                                     |
| ---------------------- | ---------------------------------------- |
| `npm ci`               | install                                  |
| `npm run typecheck`    | `tsc --noEmit` in every package          |
| `npm run lint`         | ESLint across the repo                   |
| `npm run format:check` | Prettier check (`npm run format` writes) |
| `npm run build`        | build every package that defines a build |
| `npm test`             | Vitest across every package              |

Vitest runs two kinds of project: each package under `packages/*`, and the CI gates under
`scripts/`. The gate tests shell out to npm and esbuild and have their own long timeouts, which is
why they are declared separately in `vitest.config.ts` rather than picked up by the package glob.
`npm run test:coverage` enforces per-package thresholds — 90% for the two Node packages, 80% for
React Native.

The three directories under `examples/` are **not** npm workspace members. `mock-api` and
`node-server` install nothing and run off the repository's hoisted `node_modules`; `expo-app` has its own
`node_modules` and needs `npm ci --prefix examples/expo-app`. Each has a README.

A pull request runs the quality gates and the suite on the Node version `.nvmrc` pins. The second
Node major additionally runs on `main` and on a pull request carrying the **`ci:full`** label.
Applying that label re-runs the workflow; any other label triggers a run whose jobs all skip, so a
stray label costs nothing.

The Android build never runs on its own. It takes ten minutes against eighty seconds for everything
else, so it is asked for rather than assumed: tick the box on a workflow dispatch, or put `ci:full`
on the pull request. Nothing builds the native module automatically, so run the Gradle command
below yourself before merging a change that touches it.

## The Android module

The Expo Android module in `packages/verification-react-native/android` is built by a Gradle root at
the **repository root** — `settings.gradle`, `build.gradle` and `gradlew` are top-level files. It
lives there rather than inside the package because the build resolves React Native and Expo's Gradle
plugins through `node_modules`, and because an Expo module cannot be configured without a
`com.android.application` module in the same build. That module is `manifest-probe`, included as
`:app`; it is never published and declares nothing of its own, so its merged manifest is exactly
what an integrator inherits.

```sh
./gradlew \
  :didww-verification-react-native:assemble \
  :didww-verification-react-native:test \
  :app:check
```

A JDK 17 must be installed somewhere Gradle can find it, and `ANDROID_HOME` must point at an Android
SDK. There is no `JAVA_HOME` in that command on purpose: the root build declares a Java toolchain, so
Gradle locates a 17 itself and compiles against it whatever it was launched on. Setting it by hand
has no spelling that works on every host, which is why the build resolves it instead. The
`:app:check` half compares the merged manifest against `manifest-probe/manifest-golden.txt` **by
position**, not against an allowlist of element types, so a dependency bump that contributes a
`<service>` or a `<permission>` nobody typed fails the build. Regenerate a deliberate change with
`-Pmanifest.golden.update=true` and read the diff before committing it.

No JavaScript command touches any of this. CI runs it in the `Android` job, on `main`, on a
`ci:full` pull request, or when the change touches a path the build depends on — the module's
`android/` tree, `manifest-probe/`, the Gradle files, and `package-lock.json`. Run it locally when
you change the module, and at release.

## Rules that are enforced, not just asked for

**`@didww/verification-core` has no runtime dependencies.** Not one, not optional, not peer. It is
checked in CI by `scripts/check-zero-deps.mjs`, which reads the manifest, resolves the production
subtree and installs the packed tarball into an empty project. Do not add a dependency to that
package — reach for a different design instead. A dependency there lands in every consumer of all
three packages, including a React Native bundle, and the package deliberately has no
runtime-specific API to justify one.

**No Node builtin may be reachable from the React Native bundle.** Metro cannot resolve `node:crypto`
and a customer's build breaks on install. Checked in CI by `scripts/check-no-node-builtins.mjs`,
which bundles the built entry point and fails on any builtin, naming the importer. Its one blind
spot is a computed import specifier, which ESLint bans separately.

**No source file in `packages/verification-react-native` may import `react-native`.** It is a peer
dependency, so `tsc` resolves its types, but vitest cannot parse its Flow-typed source and a
type-only import is erased before vitest would notice. Lint is the only gate that sees either form.
The SMS auto-capture gate reads the native module's presence instead of `Platform.OS`.

**Comments are the exception, not the habit.** Names, types and small functions carry the meaning.
A comment earns its place when it records something the code cannot show: a wire invariant, a silent
failure mode, or why an obvious alternative is wrong. When one survives it is a sentence or two,
never a rationale essay. Public API surfaces get a one-line TSDoc; internals usually get none.

**Nothing internal reaches this repository.** `scripts/check-no-internal-refs.mjs` greps for
issue-tracker keys, references to a task in a plan document, and non-public environment URLs. It
matches by shape — a tracker key is `\b[A-Z]{2,}-\d+\b` against a small allowlist of published
vocabularies — so you cannot write one even as an example.

It also loads a set of rules whose patterns cannot be written down here, because each one is the
string it looks for. Those live outside the public tree, so a run from a full checkout is stricter
than a run from this one; the script prints which of the two it did on every run. Read that line
before trusting a pass.

## Writing a script in `scripts/`

The flat ESLint config declares Node globals for `scripts/**/*.mjs` and `*.mjs` by hand —
`Buffer`, `console`, `fetch`, `process`, `URL`. A script using anything else (`setTimeout`,
`TextEncoder`) must extend that list in `eslint.config.mjs` or `no-undef` fails the `quality` job.

Everything here is a CI gate: it runs on a stock runner from a clean checkout and needs nothing
this repository does not carry. A check that needs more than that does not belong in `scripts/`.

## Documentation

`docs/callbacks.md` is the reference for the inbound gate: the string that is signed, the order
rejections are decided in, and the traps a bare-origin callback URL sets. Everything else a
consumer needs is in the package READMEs, beside the code it describes.

Releases are cut by hand. There is no publish workflow in `.github/workflows/` and none should be
added.
