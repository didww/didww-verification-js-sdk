import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '@didww/verification-core';
import type { ApiErrorItem, KnownApiErrorCode, Verification } from '@didww/verification-core';
import { initialMachineState, isTerminalState, verificationReducer } from './machine.js';
import type { MachineState, VerificationEvent } from './machine.js';

// Restated from the specification rather than imported from the reducer, so a change to the
// partition fails here instead of agreeing with itself. `satisfies` ties each slug to core's
// vocabulary: a renamed slug stops compiling.
const RECOVERABLE = [
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

const TERMINAL_SLUGS = API_ERROR_CODES.filter(
  (code) => !(RECOVERABLE as readonly string[]).includes(code),
);

// The four slugs the terminal map treats specially; every other terminal slug becomes `failed`.
const SPECIAL_TERMINAL: readonly string[] = [
  'denied_missing_callback_url',
  'denied_by_callback',
  'denied_invalid_callback_response',
  'expired',
];

const EXPIRES_AT = new Date('2026-01-01T00:00:00.000Z');

const BASE: Omit<Verification, 'unsafeRawPayload'> = {
  id: 'ver-1',
  destination: '+15550001111',
  deliveryMethod: 'sms',
  fee: '0.0450',
  status: 'pending',
  errorCode: null,
  errorDetail: null,
  expiresAt: EXPIRES_AT,
  sms: {
    template: 'Your code is {code}',
    language: 'en-US',
    interceptionTimeoutSeconds: 120,
    appHash: 'FA+9qCX9VSu',
  },
  callout: null,
};

function verification(
  overrides: Partial<Omit<Verification, 'unsafeRawPayload'>> = {},
): Verification {
  return { ...BASE, ...overrides };
}

function item(code: string, detail: string | null = 'prose'): ApiErrorItem {
  return { code, detail };
}

function reduceAll(events: readonly VerificationEvent[], from = initialMachineState): MachineState {
  return events.reduce(verificationReducer, from);
}

/** A live verification awaiting a value. */
function awaitingInput(): MachineState {
  return reduceAll([
    { type: 'startRequested' },
    { type: 'startSucceeded', verification: verification() },
  ]);
}

function submitting(): MachineState {
  return verificationReducer(awaitingInput(), { type: 'submitRequested' });
}

describe('start', () => {
  it('moves idle to starting', () => {
    expect(verificationReducer(initialMachineState, { type: 'startRequested' }).state).toEqual({
      kind: 'starting',
    });
  });

  it('lands on awaitingInput with the verification data', () => {
    expect(awaitingInput()).toEqual({
      state: {
        kind: 'awaitingInput',
        verificationId: 'ver-1',
        deliveryMethod: 'sms',
        destination: '+15550001111',
        fee: '0.0450',
        sms: BASE.sms,
        callout: null,
        expiresAt: EXPIRES_AT,
        lastError: null,
      },
      active: {
        verificationId: 'ver-1',
        deliveryMethod: 'sms',
        destination: '+15550001111',
        fee: '0.0450',
        sms: BASE.sms,
        callout: null,
        expiresAt: EXPIRES_AT,
      },
    });
  });

  it('carries the callout block through to awaitingInput', () => {
    const next = reduceAll([
      { type: 'startRequested' },
      {
        type: 'startSucceeded',
        verification: verification({
          deliveryMethod: 'callout',
          sms: null,
          callout: { language: 'pt-PT' },
        }),
      },
    ]);

    expect(next.state).toMatchObject({ kind: 'awaitingInput', callout: { language: 'pt-PT' } });
  });

  it('applies a terminal status returned by start itself', () => {
    const next = reduceAll([
      { type: 'startRequested' },
      { type: 'startSucceeded', verification: verification({ status: 'verified' }) },
    ]);
    expect(next).toEqual({ state: { kind: 'verified', verificationId: 'ver-1' }, active: null });
  });

  it('ignores a response that arrives after the state left starting', () => {
    const live = awaitingInput();
    expect(
      verificationReducer(live, { type: 'startSucceeded', verification: verification() }),
    ).toBe(live);
    expect(
      verificationReducer(live, {
        type: 'startFailed',
        reason: { source: 'api', error: item('internal_error') },
      }),
    ).toBe(live);
  });
});

describe('every error during starting is terminal', () => {
  it.each(RECOVERABLE)('%s fails the start rather than returning to awaitingInput', (code) => {
    const next = reduceAll([
      { type: 'startRequested' },
      { type: 'startFailed', reason: { source: 'api', error: item(code) } },
    ]);
    expect(next).toEqual({
      state: { kind: 'failed', reason: { source: 'api', error: item(code) } },
      active: null,
    });
  });

  it('maps a start failure through the same terminal table', () => {
    const next = reduceAll([
      { type: 'startRequested' },
      {
        type: 'startFailed',
        reason: { source: 'api', error: item('denied_missing_callback_url', 'no url') },
      },
    ]);
    expect(next.state).toEqual({
      kind: 'setupError',
      code: 'denied_missing_callback_url',
      detail: 'no url',
    });
  });

  it('maps an SDK failure during starting', () => {
    const next = reduceAll([
      { type: 'startRequested' },
      {
        type: 'startFailed',
        reason: { source: 'sdk', error: { code: 'transport', message: 'ETIMEDOUT' } },
      },
    ]);
    expect(next.state).toEqual({
      kind: 'failed',
      reason: { source: 'sdk', error: { code: 'transport', message: 'ETIMEDOUT' } },
    });
  });
});

describe('recoverable submit failures', () => {
  it.each(RECOVERABLE)('%s returns to awaitingInput with lastError and the row alive', (code) => {
    const failed = item(code, 'why');
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: failed },
    });

    expect(next.state).toEqual({
      kind: 'awaitingInput',
      verificationId: 'ver-1',
      deliveryMethod: 'sms',
      destination: '+15550001111',
      fee: '0.0450',
      sms: BASE.sms,
      callout: null,
      expiresAt: EXPIRES_AT,
      lastError: failed,
    });
    expect(next.active).toEqual(submitting().active);
  });

  it('replaces the previous lastError on the next failure', () => {
    const next = reduceAll(
      [
        { type: 'submitFailed', reason: { source: 'api', error: item('code_invalid', 'first') } },
        { type: 'submitRequested' },
        { type: 'submitFailed', reason: { source: 'api', error: item('code_blank', 'second') } },
      ],
      submitting(),
    );
    expect(next.state).toMatchObject({
      kind: 'awaitingInput',
      lastError: item('code_blank', 'second'),
    });
  });
});

describe('terminal submit failures', () => {
  it.each(TERMINAL_SLUGS.filter((code) => !SPECIAL_TERMINAL.includes(code)))(
    '%s fails with the API item',
    (code) => {
      const next = verificationReducer(submitting(), {
        type: 'submitFailed',
        reason: { source: 'api', error: item(code) },
      });
      expect(next).toEqual({
        state: { kind: 'failed', reason: { source: 'api', error: item(code) } },
        active: null,
      });
    },
  );

  it('denied_missing_callback_url is a setup error', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item('denied_missing_callback_url', 'register one') },
    });
    expect(next.state).toEqual({
      kind: 'setupError',
      code: 'denied_missing_callback_url',
      detail: 'register one',
    });
  });

  it.each(['denied_by_callback', 'denied_invalid_callback_response'])('%s is denied', (code) => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item(code) },
    });
    expect(next.state).toEqual({ kind: 'denied', error: item(code) });
  });

  it('expired is expired', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item('expired') },
    });
    expect(next.state).toEqual({ kind: 'expired' });
  });

  it('too_many_attempts is terminal — the server, not a local counter, decides', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item('too_many_attempts') },
    });
    expect(next.state.kind).toBe('failed');
    expect(isTerminalState(next.state)).toBe(true);
  });

  it('already_verified is a failure, never verified', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item('already_verified') },
    });
    expect(next.state).toEqual({
      kind: 'failed',
      reason: { source: 'api', error: item('already_verified') },
    });
  });

  it('an unmodelled slug fails rather than recovering', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'api', error: item('slug_from_a_later_release') },
    });
    expect(next.state.kind).toBe('failed');
  });

  it('an SDK failure fails with source sdk', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitFailed',
      reason: { source: 'sdk', error: { code: 'decoding', message: 'bad json' } },
    });
    expect(next.state).toEqual({
      kind: 'failed',
      reason: { source: 'sdk', error: { code: 'decoding', message: 'bad json' } },
    });
  });

  it('ignores a submit failure with no live verification', () => {
    expect(
      verificationReducer(initialMachineState, {
        type: 'submitFailed',
        reason: { source: 'api', error: item('code_invalid') },
      }),
    ).toBe(initialMachineState);
  });
});

describe('status mapping', () => {
  it('verified', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({ status: 'verified' }),
    });
    expect(next).toEqual({ state: { kind: 'verified', verificationId: 'ver-1' }, active: null });
  });

  it('expired', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({ status: 'expired', errorCode: 'expired' }),
    });
    expect(next.state).toEqual({ kind: 'expired' });
  });

  it('failed carries the error item', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({
        status: 'failed',
        errorCode: 'dispatch_failed',
        errorDetail: 'no route',
      }),
    });
    expect(next.state).toEqual({
      kind: 'failed',
      reason: { source: 'api', error: item('dispatch_failed', 'no route') },
    });
  });

  it('failed falls back to internal_error when the server named no code', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({ status: 'failed' }),
    });
    expect(next.state).toEqual({
      kind: 'failed',
      reason: { source: 'api', error: { code: 'internal_error', detail: null } },
    });
  });

  it('denied with no code', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({ status: 'denied' }),
    });
    expect(next.state).toEqual({ kind: 'denied', error: null });
  });

  it('denied routes its code through the terminal table', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification({
        status: 'denied',
        errorCode: 'denied_missing_callback_url',
        errorDetail: 'register one',
      }),
    });
    expect(next.state).toEqual({
      kind: 'setupError',
      code: 'denied_missing_callback_url',
      detail: 'register one',
    });
  });

  it.each(['denied_by_callback', 'denied_invalid_callback_response'])(
    'denied with %s stays denied',
    (code) => {
      const next = verificationReducer(submitting(), {
        type: 'submitSucceeded',
        verification: verification({ status: 'denied', errorCode: code, errorDetail: null }),
      });
      expect(next.state).toEqual({ kind: 'denied', error: item(code, null) });
    },
  );

  it('a successful report that is still pending returns to awaitingInput', () => {
    const next = verificationReducer(submitting(), {
      type: 'submitSucceeded',
      verification: verification(),
    });
    expect(next.state).toMatchObject({ kind: 'awaitingInput', lastError: null });
  });

  it('ignores a report response with no live verification', () => {
    expect(
      verificationReducer(initialMachineState, {
        type: 'submitSucceeded',
        verification: verification({ status: 'verified' }),
      }),
    ).toBe(initialMachineState);
  });
});

describe('refresh', () => {
  it('pending is a no-op', () => {
    const live = awaitingInput();
    expect(verificationReducer(live, { type: 'refreshed', verification: verification() })).toBe(
      live,
    );
  });

  it('an unrecognised status is a no-op', () => {
    const live = awaitingInput();
    expect(
      verificationReducer(live, {
        type: 'refreshed',
        verification: verification({ status: 'quarantined' }),
      }),
    ).toBe(live);
  });

  it('a terminal status ends the verification', () => {
    const next = verificationReducer(awaitingInput(), {
      type: 'refreshed',
      verification: verification({ status: 'verified' }),
    });
    expect(next).toEqual({ state: { kind: 'verified', verificationId: 'ver-1' }, active: null });
  });

  it('is ignored once the outcome is decided', () => {
    const done = verificationReducer(awaitingInput(), {
      type: 'refreshed',
      verification: verification({ status: 'verified' }),
    });
    expect(verificationReducer(done, { type: 'refreshed', verification: verification() })).toBe(
      done,
    );
  });
});

describe('sms capture', () => {
  it('captures a value while awaiting input and keeps the verification alive', () => {
    const live = awaitingInput();
    const next = verificationReducer(live, { type: 'smsCaptured', value: '1234' });
    expect(next.state).toEqual({ kind: 'captured', value: '1234' });
    expect(next.active).toEqual(live.active);
  });

  it('submits from captured', () => {
    const next = reduceAll(
      [{ type: 'smsCaptured', value: '1234' }, { type: 'submitRequested' }],
      awaitingInput(),
    );
    expect(next.state).toEqual({ kind: 'submitting' });
  });

  it('is ignored outside awaitingInput', () => {
    const busy = submitting();
    expect(verificationReducer(busy, { type: 'smsCaptured', value: '1234' })).toBe(busy);
    expect(verificationReducer(initialMachineState, { type: 'smsCaptured', value: '1234' })).toBe(
      initialMachineState,
    );
  });
});

describe('submit request', () => {
  it('is ignored before a verification exists', () => {
    const starting = verificationReducer(initialMachineState, { type: 'startRequested' });
    expect(verificationReducer(starting, { type: 'submitRequested' })).toBe(starting);
  });
});

describe('sdk errors', () => {
  it.each([
    { code: 'already_running' },
    { code: 'superseded' },
    { code: 'transport', message: 'socket hang up' },
    { code: 'decoding', message: 'unexpected token' },
  ] as const)('$code is a terminal sdk failure', (error) => {
    const next = verificationReducer(awaitingInput(), { type: 'sdkError', error });
    expect(next).toEqual({
      state: { kind: 'failed', reason: { source: 'sdk', error } },
      active: null,
    });
  });

  it('is ignored once the outcome is decided', () => {
    const done = verificationReducer(awaitingInput(), {
      type: 'refreshed',
      verification: verification({ status: 'verified' }),
    });
    expect(verificationReducer(done, { type: 'sdkError', error: { code: 'superseded' } })).toBe(
      done,
    );
  });
});

describe('reset and restart', () => {
  it('reset returns to the initial state from anywhere', () => {
    expect(verificationReducer(submitting(), { type: 'reset' })).toBe(initialMachineState);
    expect(verificationReducer(initialMachineState, { type: 'reset' })).toBe(initialMachineState);
  });

  it('a fresh start clears the previous verification', () => {
    const next = verificationReducer(awaitingInput(), { type: 'startRequested' });
    expect(next).toEqual({ state: { kind: 'starting' }, active: null });
  });
});

describe('isTerminalState', () => {
  it.each([
    { kind: 'idle' },
    { kind: 'starting' },
    { kind: 'submitting' },
    { kind: 'captured', value: '1234' },
  ] as const)('$kind is not terminal', (state) => {
    expect(isTerminalState(state)).toBe(false);
  });

  it.each([
    { kind: 'verified', verificationId: 'ver-1' },
    { kind: 'failed', reason: { source: 'sdk', error: { code: 'superseded' } } },
    { kind: 'denied', error: null },
    { kind: 'expired' },
    { kind: 'setupError', code: 'denied_missing_callback_url', detail: null },
  ] as const)('$kind is terminal', (state) => {
    expect(isTerminalState(state)).toBe(true);
  });

  it('awaitingInput is not terminal', () => {
    expect(isTerminalState(awaitingInput().state)).toBe(false);
  });
});

describe('the partition covers the whole vocabulary', () => {
  it('splits the known slugs 9 recoverable / 22 terminal', () => {
    expect(RECOVERABLE).toHaveLength(9);
    expect(TERMINAL_SLUGS).toHaveLength(API_ERROR_CODES.length - RECOVERABLE.length);
  });
});
