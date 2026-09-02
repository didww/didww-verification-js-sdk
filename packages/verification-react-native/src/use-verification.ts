import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isApiError,
  isKnownDeliveryMethod,
  type CalloutOptions,
  type DeliveryMethod,
  type SmsOptions,
  type Verification,
  type VerificationClient,
} from '@didww/verification-core';

import { initialMachineState, isTerminalState, verificationReducer } from './machine.js';
import type { MachineState, VerificationEvent } from './machine.js';
import { getAppHash } from './sms/app-hash.js';
import { armSmsListener, withAppHash, type SmsListenerHandle } from './sms/listener.js';
import type { FailureReason, SdkError, VerificationState } from './state.js';

export interface StartInput {
  readonly destination: string;
  readonly deliveryMethod: DeliveryMethod;
  readonly sms?: SmsOptions;
  readonly callout?: CalloutOptions;
}

export interface ResumeInput {
  readonly destination: string;
  readonly deliveryMethod: DeliveryMethod;
}

export interface ResumeByIdInput {
  readonly verificationId: string;
  readonly deliveryMethod: DeliveryMethod;
}

export interface VerificationController {
  readonly state: VerificationState;
  start(input: StartInput): void;
  /** Reattach to the newest verification for a number. */
  resume(input: ResumeInput): void;
  /** Reattach by id — for an app that persisted one across a restart. */
  resumeById(input: ResumeByIdInput): void;
  /** Valid at any time; buffered until live. Never throws. Single-flighted. */
  submit(value: string): void;
  reset(): void;
}

export interface UseVerificationOptions {
  /** Constructed once by the host, outside render. */
  readonly client: VerificationClient;
  /** Default true. Auto-capture still needs Android and the linked native module. */
  readonly autoCapture?: boolean;
}

function sdkErrorFor(error: unknown): SdkError {
  const message = error instanceof Error ? error.message : String(error);
  // `name` rather than `instanceof`: two installed copies of core defeat the prototype check.
  return error instanceof Error && error.name === 'DecodingError'
    ? { code: 'decoding', message }
    : { code: 'transport', message };
}

function reasonFor(error: unknown): FailureReason {
  if (isApiError(error)) {
    const item = error.errors[0];
    // An ingress can answer with a body that was never this API's envelope; the status survives in
    // `detail` so the outcome is not attributed to a slug the server never sent.
    return { source: 'api', error: item ?? { code: 'internal_error', detail: error.message } };
  }
  return { source: 'sdk', error: sdkErrorFor(error) };
}

// Past the 32-bit range a timer fires immediately rather than never, which would disarm at once.
const MAX_TIMEOUT_MS = 2_147_483_647;

interface Runtime {
  readonly methods: Omit<VerificationController, 'state'>;
  enterMount(): void;
  scheduleTeardown(): void;
}

function createRuntime(
  optionsRef: { current: UseVerificationOptions },
  publish: (state: VerificationState) => void,
): Runtime {
  let machine: MachineState = initialMachineState;
  let mounted = true;
  /** Bumped by every mount of the owning effect, so a start can tell a replay from a second call. */
  let generation = 0;
  /** Bumped by every operation; a result whose token is stale belongs to a superseded run. */
  let run = 0;
  let startRun: number | null = null;
  let startGeneration = 0;
  let submitting = false;
  let buffered: string | null = null;
  let abort: AbortController | null = null;
  let listener: SmsListenerHandle | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let deferredTeardown: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    listener?.disarm();
    listener = null;
    if (expiry !== null) {
      clearTimeout(expiry);
      expiry = null;
    }
  };

  const dispatch = (event: VerificationEvent): void => {
    const next = verificationReducer(machine, event);
    if (next === machine) {
      return;
    }
    machine = next;
    if (isTerminalState(next.state)) {
      disarm();
    }
    if (mounted) {
      publish(next.state);
    }
  };

  const nextSignal = (): AbortSignal => {
    abort = new AbortController();
    return abort.signal;
  };

  const autoCaptureEnabled = (): boolean => optionsRef.current.autoCapture !== false;

  const armFor = (verification: Verification, sentAppHash: string | null): void => {
    const sms = verification.sms;
    if (!autoCaptureEnabled() || verification.deliveryMethod !== 'sms' || sms === null) {
      return;
    }
    listener = armSmsListener({
      sentAppHash,
      template: sms.template,
      echoedAppHash: sms.appHash,
      interceptionTimeoutSeconds: sms.interceptionTimeoutSeconds,
      onCode: (code) => dispatch({ type: 'smsCaptured', value: code }),
    });
  };

  // The listener owns the interception-timeout budget; the verification's own deadline is the
  // hook's, and a row that arrives already past it is never left armed.
  const scheduleExpiry = (expiresAt: Date | null): void => {
    if (listener === null || expiresAt === null) {
      return;
    }
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      disarm();
      return;
    }
    if (remaining > MAX_TIMEOUT_MS) {
      return;
    }
    expiry = setTimeout(disarm, remaining);
  };

  const flushBuffered = (): void => {
    const value = buffered;
    if (value === null) {
      return;
    }
    buffered = null;
    // No live verification means the start settled into a terminal state, so the value can never
    // apply and holding it would submit it against the next verification instead.
    if (machine.active !== null) {
      submit(value);
    }
  };

  const runStart = (
    deliveryMethod: DeliveryMethod,
    issue: (signal: AbortSignal, appHash: string | null) => Promise<Verification>,
  ): void => {
    if (startRun !== null) {
      // StrictMode replays the host's mount effect after a cleanup, and the same call across that
      // boundary is one intent rather than a second verification. The generation tells them apart:
      // a genuine unmount would have taken these bindings with it.
      if (generation !== startGeneration) {
        startGeneration = generation;
        return;
      }
      dispatch({ type: 'sdkError', error: { code: 'already_running' } });
      return;
    }

    run += 1;
    const token = run;
    startRun = token;
    startGeneration = generation;
    disarm();
    dispatch({ type: 'startRequested' });
    const signal = nextSignal();

    void (async () => {
      let appHash: string | null = null;
      try {
        // An absent hash never blocks the verification: `withAppHash` leaves the options alone and
        // the listener declines to arm. Skipped when auto-capture is off, since nothing would
        // consume the hash the server then appends.
        if (deliveryMethod === 'sms' && autoCaptureEnabled()) {
          appHash = await getAppHash();
        }
        const verification = await issue(signal, appHash);
        if (token !== run) {
          return;
        }
        dispatch({ type: 'startSucceeded', verification });
        armFor(verification, appHash);
        scheduleExpiry(verification.expiresAt);
      } catch (error) {
        if (token !== run) {
          return;
        }
        dispatch({ type: 'startFailed', reason: reasonFor(error) });
      } finally {
        if (token === run) {
          startRun = null;
          flushBuffered();
        }
      }
    })();
  };

  const report = (
    id: string,
    method: DeliveryMethod,
    value: string,
    signal: AbortSignal,
  ): Promise<Verification> => {
    const client = optionsRef.current.client;
    // A decoded delivery method is open, so the closed `ReportOptions` may reject it. Every channel
    // this release models is reported with `code`; an unknown one takes the escape hatch, which
    // does not narrow and does not guard.
    return isKnownDeliveryMethod(method)
      ? client.reportVerification(id, { deliveryMethod: method, code: value, signal })
      : client.reportVerificationRaw(id, { deliveryMethod: method, code: value, signal });
  };

  const submit = (value: string): void => {
    if (submitting) {
      return;
    }
    const active = machine.active;
    if (active === null) {
      // Buffered only while a verification can still become live. A value held past a terminal
      // outcome would be submitted against whichever verification starts next.
      if (!isTerminalState(machine.state)) {
        buffered = value;
      }
      return;
    }

    submitting = true;
    run += 1;
    const token = run;
    dispatch({ type: 'submitRequested' });
    const signal = nextSignal();

    void (async () => {
      try {
        const verification = await report(
          active.verificationId,
          active.deliveryMethod,
          value,
          signal,
        );
        if (token === run) {
          dispatch({ type: 'submitSucceeded', verification });
        }
      } catch (error) {
        if (token === run) {
          dispatch({ type: 'submitFailed', reason: reasonFor(error) });
        }
      } finally {
        if (token === run) {
          submitting = false;
        }
      }
    })();
  };

  // No channel test: the hash is read only for `sms`, and `withAppHash` returns the options
  // untouched for a null one, so every other channel passes through unchanged.
  const smsOptionsFor = (input: StartInput, appHash: string | null): { sms?: SmsOptions } => {
    const sms = withAppHash(input.sms, appHash);
    return sms === undefined ? {} : { sms };
  };

  const methods: Omit<VerificationController, 'state'> = {
    start(input) {
      runStart(input.deliveryMethod, (signal, appHash) =>
        optionsRef.current.client.startVerification({
          destination: input.destination,
          deliveryMethod: input.deliveryMethod,
          ...smsOptionsFor(input, appHash),
          ...(input.callout === undefined ? {} : { callout: input.callout }),
          signal,
        }),
      );
    },
    resume(input) {
      runStart(input.deliveryMethod, (signal) =>
        optionsRef.current.client.getVerificationByNumber(input.destination, { signal }),
      );
    },
    resumeById(input) {
      runStart(input.deliveryMethod, (signal) =>
        optionsRef.current.client.getVerification(input.verificationId, { signal }),
      );
    },
    submit(value) {
      submit(value);
    },
    reset() {
      run += 1;
      startRun = null;
      submitting = false;
      buffered = null;
      abort?.abort();
      abort = null;
      disarm();
      dispatch({ type: 'reset' });
    },
  };

  return {
    methods,
    enterMount() {
      generation += 1;
      mounted = true;
      if (deferredTeardown !== null) {
        clearTimeout(deferredTeardown);
        deferredTeardown = null;
      }
    },
    // Deferred by one macrotask and cancelled when the effect re-runs. Without it StrictMode's
    // mount -> cleanup -> mount would abort the one request the first mount issued, leaving the
    // request count right and the feature dead.
    scheduleTeardown() {
      deferredTeardown = setTimeout(() => {
        deferredTeardown = null;
        mounted = false;
        abort?.abort();
        disarm();
      }, 0);
    },
  };
}

/** Drives one verification: start or reattach, submit, and SMS auto-capture where it can run. */
export function useVerification(options: UseVerificationOptions): VerificationController {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<VerificationState>(initialMachineState.state);
  const runtimeRef = useRef<Runtime | null>(null);
  runtimeRef.current ??= createRuntime(optionsRef, setState);
  const runtime = runtimeRef.current;

  useEffect(() => {
    runtime.enterMount();
    return () => runtime.scheduleTeardown();
  }, [runtime]);

  return useMemo(() => ({ state, ...runtime.methods }), [state, runtime]);
}
