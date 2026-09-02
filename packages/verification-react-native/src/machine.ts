import type { ApiErrorItem, KnownApiErrorCode, Verification } from '@didww/verification-core';
import type { FailureReason, SdkError, VerificationState } from './state.js';

/** The live verification, kept across `captured` and `submitting` so a recoverable error can restore `awaitingInput`. */
export type ActiveVerification = Omit<
  Extract<VerificationState, { kind: 'awaitingInput' }>,
  'kind' | 'lastError'
>;

/** Reducer state: what the host renders, plus the context a recoverable error is restored from. */
export interface MachineState {
  readonly state: VerificationState;
  /** Non-null exactly while a verification is live. A stale response with no live row is ignored. */
  readonly active: ActiveVerification | null;
}

export type VerificationEvent =
  | { readonly type: 'startRequested' }
  | { readonly type: 'startSucceeded'; readonly verification: Verification }
  | { readonly type: 'startFailed'; readonly reason: FailureReason }
  | { readonly type: 'submitRequested' }
  | { readonly type: 'submitSucceeded'; readonly verification: Verification }
  | { readonly type: 'submitFailed'; readonly reason: FailureReason }
  /** A value read out of an incoming SMS, not typed by the user. */
  | { readonly type: 'smsCaptured'; readonly value: string }
  /** The result of a poll or a manual refresh. */
  | { readonly type: 'refreshed'; readonly verification: Verification }
  /** An SDK failure not attached to an in-flight request — a rejected duplicate start, or supersession. */
  | { readonly type: 'sdkError'; readonly error: SdkError }
  | { readonly type: 'reset' };

export const initialMachineState: MachineState = { state: { kind: 'idle' }, active: null };

/**
 * The server decides whether another attempt is allowed, so there is no local counter and
 * `too_many_attempts` is absent. `already_verified` too: the row succeeded earlier but this
 * submission was wrong, so reporting it as success would admit someone who typed the wrong code.
 */
const RECOVERABLE_ERROR_CODES = [
  'code_invalid',
  'cli_invalid',
  'code_blank',
  'cli_blank',
  'code_value_present',
  'cli_value_present',
  'delivery_method_invalid',
  'validation_failed',
  'not_ready_to_report',
] as const satisfies readonly KnownApiErrorCode[];

const TERMINAL_KINDS: readonly VerificationState['kind'][] = [
  'verified',
  'failed',
  'denied',
  'expired',
  'setupError',
];

/** True once the outcome is decided. Only `reset` and a fresh `startRequested` leave these states. */
export function isTerminalState(state: VerificationState): boolean {
  return TERMINAL_KINDS.includes(state.kind);
}

function isRecoverable(code: string): boolean {
  return (RECOVERABLE_ERROR_CODES as readonly string[]).includes(code);
}

function terminalForErrorItem(item: ApiErrorItem): VerificationState {
  switch (item.code) {
    case 'denied_missing_callback_url':
      return { kind: 'setupError', code: 'denied_missing_callback_url', detail: item.detail };
    case 'denied_by_callback':
    case 'denied_invalid_callback_response':
      return { kind: 'denied', error: item };
    case 'expired':
      return { kind: 'expired' };
    default:
      return { kind: 'failed', reason: { source: 'api', error: item } };
  }
}

function errorItemOf(verification: Verification): ApiErrorItem | null {
  return verification.errorCode === null
    ? null
    : { code: verification.errorCode, detail: verification.errorDetail };
}

/** `null` means the status decides nothing: the caller keeps the state it already has. */
function terminalForStatus(verification: Verification): VerificationState | null {
  const item = errorItemOf(verification);
  switch (verification.status) {
    case 'verified':
      return { kind: 'verified', verificationId: verification.id };
    case 'expired':
      return { kind: 'expired' };
    case 'failed':
      return {
        kind: 'failed',
        reason: { source: 'api', error: item ?? { code: 'internal_error', detail: null } },
      };
    case 'denied':
      return item === null ? { kind: 'denied', error: null } : terminalForErrorItem(item);
    // `pending` decides nothing, and neither does a status this release does not model: a sixth
    // status must neither strand the user in a spinner nor report an outcome the server withheld.
    case 'pending':
    default:
      return null;
  }
}

function terminalForFailure(reason: FailureReason): VerificationState {
  return reason.source === 'api' ? terminalForErrorItem(reason.error) : { kind: 'failed', reason };
}

function activeOf(verification: Verification): ActiveVerification {
  return {
    verificationId: verification.id,
    deliveryMethod: verification.deliveryMethod,
    destination: verification.destination,
    fee: verification.fee,
    sms: verification.sms,
    callout: verification.callout,
    expiresAt: verification.expiresAt,
  };
}

function awaiting(active: ActiveVerification, lastError: ApiErrorItem | null): MachineState {
  return { state: { kind: 'awaitingInput', ...active, lastError }, active };
}

function terminal(state: VerificationState): MachineState {
  return { state, active: null };
}

export function verificationReducer(machine: MachineState, event: VerificationEvent): MachineState {
  switch (event.type) {
    case 'reset':
      return initialMachineState;

    case 'startRequested':
      return { state: { kind: 'starting' }, active: null };

    case 'startSucceeded': {
      if (machine.state.kind !== 'starting') return machine;
      const outcome = terminalForStatus(event.verification);
      return outcome === null ? awaiting(activeOf(event.verification), null) : terminal(outcome);
    }

    // The recoverable set presupposes a verification to return to; during `starting` there is none.
    case 'startFailed':
      return machine.state.kind === 'starting'
        ? terminal(terminalForFailure(event.reason))
        : machine;

    case 'submitRequested':
      return machine.active === null
        ? machine
        : { state: { kind: 'submitting' }, active: machine.active };

    case 'submitSucceeded': {
      if (machine.active === null) return machine;
      const outcome = terminalForStatus(event.verification);
      return outcome === null ? awaiting(activeOf(event.verification), null) : terminal(outcome);
    }

    case 'submitFailed': {
      const active = machine.active;
      if (active === null) return machine;
      if (event.reason.source === 'api' && isRecoverable(event.reason.error.code)) {
        return awaiting(active, event.reason.error);
      }
      return terminal(terminalForFailure(event.reason));
    }

    case 'smsCaptured':
      return machine.state.kind === 'awaitingInput'
        ? { state: { kind: 'captured', value: event.value }, active: machine.active }
        : machine;

    case 'refreshed': {
      if (machine.active === null) return machine;
      const outcome = terminalForStatus(event.verification);
      return outcome === null ? machine : terminal(outcome);
    }

    case 'sdkError':
      return isTerminalState(machine.state)
        ? machine
        : terminal({ kind: 'failed', reason: { source: 'sdk', error: event.error } });
  }
}
