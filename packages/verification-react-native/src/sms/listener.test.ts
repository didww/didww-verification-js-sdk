import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_APP_HASH_KEY,
  VerificationClient,
  publicAuth,
  type SmsOptions,
} from '@didww/verification-core';
import { fakeTransport } from '@didww/verification-core/testing';

import { armSmsListener, withAppHash, type SmsListenerOptions } from './listener.js';
import type { NativeSmsModule, SmsReceivedEvent } from './native.js';

const SENT_HASH = 'FA+9qCX9VSu';
const OTHER_HASH = 'abcdEFGH+/1';
const TEMPLATE = 'Your DIDWW code is {{CODE}}. Do not share it.';
const RETRIEVER_BODY = `<#> Your DIDWW code is 123456. Do not share it.\n${SENT_HASH}`;

/** `__DEV__` is a Metro-injected global; under vitest it is absent unless a test sets it. */
const metroGlobals = globalThis as unknown as { __DEV__?: boolean };

function setDevGlobal(value: boolean | undefined): void {
  if (value === undefined) {
    delete metroGlobals.__DEV__;
  } else {
    metroGlobals.__DEV__ = value;
  }
}

function fakeNativeModule(startRetriever: () => Promise<void> = () => Promise.resolve()) {
  const listeners: Array<(payload: SmsReceivedEvent) => void> = [];
  const remove = vi.fn(() => {
    listeners.length = 0;
  });
  const start = vi.fn(startRetriever);
  const stop = vi.fn(() => Promise.resolve());
  const addListener = vi.fn(
    (_event: 'onSmsReceived', listener: (payload: SmsReceivedEvent) => void) => {
      listeners.push(listener);
      return { remove };
    },
  );
  const module: NativeSmsModule = {
    getAppHash: () => Promise.resolve(SENT_HASH),
    startRetriever: start,
    stopRetriever: stop,
    addListener,
  };
  return {
    module,
    start,
    stop,
    addListener,
    remove,
    emit: (message: string): void => {
      for (const listener of [...listeners]) {
        listener({ message });
      }
    },
  };
}

function listenerOptions(overrides: Partial<SmsListenerOptions> = {}): SmsListenerOptions {
  return {
    sentAppHash: SENT_HASH,
    template: TEMPLATE,
    echoedAppHash: SENT_HASH,
    onCode: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  setDevGlobal(undefined);
});

afterEach(() => {
  setDevGlobal(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withAppHash', () => {
  it('returns the options untouched when there is no hash', () => {
    const options: SmsOptions = { languages: ['en-US'] };

    const result = withAppHash(options, null);

    expect(result).toBe(options);
    expect(result).not.toHaveProperty(INTERNAL_APP_HASH_KEY);
  });

  it('returns undefined when there are no options and no hash', () => {
    expect(withAppHash(undefined, null)).toBeUndefined();
  });

  it('sets exactly the internal key and keeps the supported options', () => {
    const result = withAppHash({ languages: ['en-US'] }, SENT_HASH);

    expect(result).toEqual({ languages: ['en-US'], [INTERNAL_APP_HASH_KEY]: SENT_HASH });
  });

  it('produces options from nothing when only a hash is supplied', () => {
    expect(withAppHash(undefined, SENT_HASH)).toEqual({ [INTERNAL_APP_HASH_KEY]: SENT_HASH });
  });

  it('reaches the wire as app_hash through the core request builder', async () => {
    const payload = {
      id: 'ver-1',
      destination: '+4915112345678',
      delivery_method: 'sms',
      fee: '0.0345',
      status: 'pending',
      error_code: null,
      error_detail: null,
      expires_at: '2026-08-25T10:00:00Z',
      sms: { template: TEMPLATE, interception_timeout: 120, app_hash: SENT_HASH },
    };
    const { transport, requests } = fakeTransport([
      { status: 201, headers: {}, body: JSON.stringify({ data: payload }) },
    ]);
    const client = new VerificationClient({ auth: publicAuth('test-key'), transport });

    // Spread rather than `sms:` directly: `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` for an optional property, and this function may answer one.
    const sms = withAppHash({ languages: ['en-US'] }, SENT_HASH);
    await client.startVerification({
      destination: '+4915112345678',
      deliveryMethod: 'sms',
      ...(sms === undefined ? {} : { sms }),
    });

    expect(requests[0]?.body).toContain(`"app_hash":"${SENT_HASH}"`);
    expect(requests[0]?.body).not.toContain(INTERNAL_APP_HASH_KEY);
  });
});

describe('armSmsListener does not arm', () => {
  it('when no hash was sent', () => {
    const native = fakeNativeModule();

    expect(
      armSmsListener(listenerOptions({ sentAppHash: null, module: native.module })),
    ).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('when no hash was sent and none was echoed', () => {
    // The only case the sent-hash guard uniquely handles: `null !== null` is false, so the echo
    // gate falls through and without it the Retriever would arm for a hashless message.
    const native = fakeNativeModule();

    expect(
      armSmsListener(
        listenerOptions({ sentAppHash: null, echoedAppHash: null, module: native.module }),
      ),
    ).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('when the server echoed no hash', () => {
    const native = fakeNativeModule();

    expect(
      armSmsListener(listenerOptions({ echoedAppHash: null, module: native.module })),
    ).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('when the server echoed a different hash', () => {
    const native = fakeNativeModule();

    expect(
      armSmsListener(listenerOptions({ echoedAppHash: OTHER_HASH, module: native.module })),
    ).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('when there is no template to match a body against', () => {
    const native = fakeNativeModule();

    expect(armSmsListener(listenerOptions({ template: null, module: native.module }))).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('when the native module is absent', () => {
    expect(armSmsListener(listenerOptions({ module: null }))).toBeNull();
  });

  it('when the native module is absent by default resolution', () => {
    // `expo-modules-core` is genuinely not installed in this workspace, so the default seam
    // resolves to null for real here.
    expect(armSmsListener(listenerOptions())).toBeNull();
  });

  it('when the linked module does not expose startRetriever', () => {
    const native = fakeNativeModule();
    const unlinked: NativeSmsModule = { ...native.module };
    delete (unlinked as Partial<NativeSmsModule>).startRetriever;

    expect(armSmsListener(listenerOptions({ module: unlinked }))).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });
});

describe('the echo-mismatch warning', () => {
  it('reports the mismatch through onWarn under __DEV__', () => {
    setDevGlobal(true);
    const onWarn = vi.fn();
    const native = fakeNativeModule();

    armSmsListener(listenerOptions({ echoedAppHash: OTHER_HASH, onWarn, module: native.module }));

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toContain(`echoed "${OTHER_HASH}"`);
    expect(onWarn.mock.calls[0]?.[0]).toContain(`sent "${SENT_HASH}"`);
  });

  it('reports an absent echo as well as a different one', () => {
    setDevGlobal(true);
    const onWarn = vi.fn();

    armSmsListener(listenerOptions({ echoedAppHash: null, onWarn, module: null }));

    expect(onWarn.mock.calls[0]?.[0]).toContain('echoed no app hash');
  });

  it('falls back to the console when no onWarn is supplied', () => {
    setDevGlobal(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    armSmsListener(listenerOptions({ echoedAppHash: OTHER_HASH, module: null }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('auto-capture stays off');
  });

  it('stays quiet when the hashes match', () => {
    setDevGlobal(true);
    const onWarn = vi.fn();
    const native = fakeNativeModule();

    armSmsListener(listenerOptions({ onWarn, module: native.module }));

    expect(onWarn).not.toHaveBeenCalled();
  });

  it('stays quiet in a release build', () => {
    setDevGlobal(false);
    const onWarn = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    armSmsListener(listenerOptions({ echoedAppHash: OTHER_HASH, onWarn, module: null }));

    expect(onWarn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not throw where __DEV__ is undeclared', () => {
    setDevGlobal(undefined);
    const onWarn = vi.fn();

    expect(() =>
      armSmsListener(listenerOptions({ echoedAppHash: OTHER_HASH, onWarn, module: null })),
    ).not.toThrow();
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('armSmsListener arms', () => {
  it('starts the Retriever and subscribes when the echoed hash matches', () => {
    const native = fakeNativeModule();

    const handle = armSmsListener(listenerOptions({ module: native.module }));

    expect(handle).not.toBeNull();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.addListener).toHaveBeenCalledTimes(1);
    expect(native.addListener.mock.calls[0]?.[0]).toBe('onSmsReceived');
  });

  it('reports the code extracted from a Retriever-shaped body exactly once', () => {
    const onCode = vi.fn();
    const native = fakeNativeModule();
    armSmsListener(listenerOptions({ onCode, module: native.module }));

    native.emit(RETRIEVER_BODY);

    expect(onCode).toHaveBeenCalledTimes(1);
    expect(onCode).toHaveBeenCalledWith('123456');
  });

  it('ignores a body the template does not match', () => {
    const onCode = vi.fn();
    const native = fakeNativeModule();
    armSmsListener(listenerOptions({ onCode, module: native.module }));

    expect(() => {
      native.emit('Your bank code is 4321');
    }).not.toThrow();
    expect(onCode).not.toHaveBeenCalled();
  });

  it('lets a throwing onCode propagate and stays armed', () => {
    // Chosen, not accidental: dispatch mutates no listener state, so the exception reaches the
    // host's own error reporting instead of being swallowed, and capture keeps working.
    const onCode = vi.fn(() => {
      throw new Error('host bug');
    });
    const native = fakeNativeModule();
    const handle = armSmsListener(listenerOptions({ onCode, module: native.module }));

    expect(() => native.emit(RETRIEVER_BODY)).toThrow('host bug');
    expect(() => native.emit(RETRIEVER_BODY)).toThrow('host bug');

    expect(onCode).toHaveBeenCalledTimes(2);
    expect(native.remove).not.toHaveBeenCalled();
    expect(() => handle?.disarm()).not.toThrow();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });
});

describe('disarm', () => {
  it('removes the subscription and stops the Retriever', () => {
    const native = fakeNativeModule();
    const handle = armSmsListener(listenerOptions({ module: native.module }));

    handle?.disarm();

    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('is a no-op the second time', () => {
    const native = fakeNativeModule();
    const handle = armSmsListener(listenerOptions({ module: native.module }));

    handle?.disarm();
    handle?.disarm();

    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing after disarming', () => {
    const onCode = vi.fn();
    const native = fakeNativeModule();
    const handle = armSmsListener(listenerOptions({ onCode, module: native.module }));

    handle?.disarm();
    native.emit(RETRIEVER_BODY);

    expect(onCode).not.toHaveBeenCalled();
  });

  it('absorbs a stopRetriever that throws synchronously', () => {
    const native = fakeNativeModule();
    native.stop.mockImplementation(() => {
      throw new Error('module torn down');
    });
    const handle = armSmsListener(listenerOptions({ module: native.module }));

    expect(() => handle?.disarm()).not.toThrow();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });

  it('still stops the Retriever when removing the subscription throws', () => {
    const native = fakeNativeModule();
    native.remove.mockImplementation(() => {
      throw new Error('module torn down');
    });
    const handle = armSmsListener(listenerOptions({ module: native.module }));

    // The half-disarmed case: a throw here would leave the Retriever running for the session.
    expect(() => handle?.disarm()).not.toThrow();
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('absorbs a rejected stopRetriever', async () => {
    const native = fakeNativeModule();
    native.stop.mockImplementation(() => Promise.reject(new Error('already stopped')));
    const handle = armSmsListener(listenerOptions({ module: native.module }));

    expect(() => handle?.disarm()).not.toThrow();
    await Promise.resolve();
  });
});

describe('a rejecting startRetriever', () => {
  it('leaves nothing armed, and the rejection is handled', async () => {
    const onCode = vi.fn();
    const native = fakeNativeModule(() => Promise.reject(new Error('no play services')));

    const handle = armSmsListener(listenerOptions({ onCode, module: native.module }));
    await Promise.resolve();
    await Promise.resolve();

    // `stop` and `remove` only run from the `catch`, so observing them is what proves the
    // rejection was handled rather than escaping as an unhandled one.
    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
    native.emit(RETRIEVER_BODY);
    expect(onCode).not.toHaveBeenCalled();
    expect(() => handle?.disarm()).not.toThrow();
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('warns under __DEV__', async () => {
    setDevGlobal(true);
    const onWarn = vi.fn();
    const native = fakeNativeModule(() => Promise.reject(new Error('no play services')));

    armSmsListener(listenerOptions({ onWarn, module: native.module }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onWarn.mock.calls[0]?.[0]).toContain('could not start');
  });
});

describe('a native bridge that throws synchronously', () => {
  it('does not let a throwing startRetriever escape, and leaves nothing armed', () => {
    setDevGlobal(true);
    const onCode = vi.fn();
    const onWarn = vi.fn();
    const native = fakeNativeModule();
    native.start.mockImplementation(() => {
      throw new Error('module torn down');
    });

    const handle = armSmsListener(listenerOptions({ onCode, onWarn, module: native.module }));

    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toContain('could not start');
    native.emit(RETRIEVER_BODY);
    expect(onCode).not.toHaveBeenCalled();
    expect(() => handle?.disarm()).not.toThrow();
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('does not arm when subscribing throws', () => {
    setDevGlobal(true);
    const onWarn = vi.fn();
    const native = fakeNativeModule();
    native.addListener.mockImplementation(() => {
      throw new Error('module torn down');
    });

    expect(armSmsListener(listenerOptions({ onWarn, module: native.module }))).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
    expect(onWarn.mock.calls[0]?.[0]).toContain('could not start');
  });
});

describe('the interception budget', () => {
  it('disarms itself when the budget runs out', () => {
    vi.useFakeTimers();
    const native = fakeNativeModule();
    armSmsListener(listenerOptions({ interceptionTimeoutSeconds: 120, module: native.module }));

    vi.advanceTimersByTime(120_000);

    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('is cleared by disarm', () => {
    vi.useFakeTimers();
    const native = fakeNativeModule();
    const handle = armSmsListener(
      listenerOptions({ interceptionTimeoutSeconds: 120, module: native.module }),
    );
    expect(vi.getTimerCount()).toBe(1);

    handle?.disarm();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets no timer without a positive budget', () => {
    vi.useFakeTimers();
    const native = fakeNativeModule();
    armSmsListener(listenerOptions({ interceptionTimeoutSeconds: null, module: native.module }));
    armSmsListener(listenerOptions({ interceptionTimeoutSeconds: 0, module: native.module }));

    expect(vi.getTimerCount()).toBe(0);
  });
});
