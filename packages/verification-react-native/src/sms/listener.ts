import {
  INTERNAL_APP_HASH_KEY,
  type InternalSmsOptions,
  type SmsOptions,
} from '@didww/verification-core';

import { extractCode } from './extractor.js';
import {
  getNativeSmsModule,
  supportsAutoCapture,
  type EventSubscription,
  type NativeSmsModule,
} from './native.js';

// Metro injects `__DEV__` and plain Node never defines it, so a bare read would throw a
// ReferenceError on every Node consumer.
declare const __DEV__: boolean | undefined;

function inDevBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

const PACKAGE = '[@didww/verification-react-native]';

/**
 * Attaches a device-computed SMS Retriever hash to the SMS options of a `start` call. Returns the
 * options untouched when there is no hash.
 */
export function withAppHash(
  options: SmsOptions | undefined,
  appHash: string | null,
): SmsOptions | undefined {
  if (appHash === null) {
    return options;
  }
  // Unchecked here: core's request builder validates the shape and throws before any request, so a
  // second rule in this package could only drift out of step with the one that binds.
  const withHash: InternalSmsOptions = { ...options, [INTERNAL_APP_HASH_KEY]: appHash };
  return withHash;
}

export interface SmsListenerOptions {
  /** The app hash sent with `start`, or `null` when none was sent. */
  readonly sentAppHash: string | null;
  /** `SmsInfo.template` — the body the code was rendered into. */
  readonly template: string | null;
  /** `SmsInfo.appHash` — the hash the server echoed back. */
  readonly echoedAppHash: string | null;
  /** Called with the extracted code, at most once per matching message. */
  readonly onCode: (code: string) => void;
  /** Receives the development-only diagnostics instead of the console, when supplied. */
  readonly onWarn?: (message: string) => void;
  /**
   * `SmsInfo.interceptionTimeoutSeconds`. When positive, the listener disarms itself once the
   * budget runs out. The verification's own `expiresAt` belongs to the caller.
   */
  readonly interceptionTimeoutSeconds?: number | null;
  /** @internal Seam over the resolved native module, for tests. */
  readonly module?: NativeSmsModule | null;
}

export interface SmsListenerHandle {
  /**
   * Removes the subscription, stops the Retriever and clears the budget timer. Idempotent, and
   * never throws -- it is what a React cleanup calls.
   */
  disarm(): void;
}

function warn(options: SmsListenerOptions, message: string): void {
  if (!inDevBuild()) {
    return;
  }
  if (options.onWarn !== undefined) {
    options.onWarn(message);
    return;
  }
  console.warn(message);
}

function budgetMsFor(seconds: number | null | undefined): number | null {
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;
}

function describeEcho(echoed: string | null): string {
  return echoed === null ? 'no app hash' : `"${echoed}"`;
}

const ARM_FAILED_WARNING = `${PACKAGE} SMS auto-capture could not start; use manual entry.`;

function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Teardown is best-effort and there is nowhere useful to report it.
  }
}

/**
 * Starts SMS auto-capture for one verification, or answers `null` when it cannot run. Never
 * throws, and never rejects: manual entry stays live in every case.
 */
export function armSmsListener(options: SmsListenerOptions): SmsListenerHandle | null {
  const { sentAppHash, echoedAppHash, template, onCode } = options;

  if (sentAppHash === null) {
    return null;
  }

  // Equality with what was sent is the only confirmation the server stored the hash. Anything else
  // means the message carries a hash this build cannot match, so the Retriever would never fire —
  // silently, hence the warning.
  if (echoedAppHash !== sentAppHash) {
    warn(
      options,
      `${PACKAGE} The server echoed ${describeEcho(echoedAppHash)} for a request that sent ` +
        `"${sentAppHash}", so SMS auto-capture stays off for this verification. Manual entry is ` +
        `unaffected. Check that getAppHash() reports the hash of the build that is running.`,
    );
    return null;
  }

  if (template === null) {
    return null;
  }

  const native = options.module === undefined ? getNativeSmsModule() : options.module;
  if (native === null || !supportsAutoCapture(native)) {
    return null;
  }

  let disarmed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let subscription: EventSubscription;
  try {
    subscription = native.addListener('onSmsReceived', (event) => {
      const code = extractCode(template, event.message);
      if (code !== null) {
        // Deliberately unguarded: dispatch mutates nothing here, so a throwing host callback
        // leaves the listener armed and correct, and swallowing it would hide a host bug.
        onCode(code);
      }
    });
  } catch {
    warn(options, ARM_FAILED_WARNING);
    return null;
  }

  const disarm = (): void => {
    if (disarmed) {
      return;
    }
    disarmed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // Every step runs even if an earlier one fails, and none may throw: a torn-down bridge raises
    // synchronously rather than rejecting, and this is what a React cleanup calls — a throw would
    // abort the unmount and leave the Retriever running for the rest of the session.
    quietly(() => subscription.remove());
    quietly(() => void native.stopRetriever().catch(() => undefined));
  };

  const budget = budgetMsFor(options.interceptionTimeoutSeconds);
  if (budget !== null) {
    timer = setTimeout(disarm, budget);
  }

  const startFailed = (): void => {
    warn(options, ARM_FAILED_WARNING);
    disarm();
  };
  // A failed start would leave the subscription attached with nothing feeding it, so both failure
  // shapes disarm. The handle is returned either way, already disarmed, since a rejection lands
  // after this function returns.
  try {
    void native.startRetriever().catch(startFailed);
  } catch {
    startFailed();
  }

  return { disarm };
}
