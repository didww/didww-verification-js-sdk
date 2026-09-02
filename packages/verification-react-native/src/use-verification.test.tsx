import { StrictMode, useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TransportError,
  VerificationClient,
  publicAuth,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '@didww/verification-core';
import { fakeTransport } from '@didww/verification-core/testing';

import { useVerification } from './use-verification.js';
import type { StartInput, VerificationController } from './use-verification.js';
import type { NativeSmsModule, SmsReceivedEvent } from './sms/native.js';

const nativeState = vi.hoisted(() => ({ module: null as NativeSmsModule | null }));

// The whole native seam is mocked, so `getAppHash` and `armSmsListener` run for real against it:
// arming, disarming and the app hash are observed as native calls rather than as mocked SDK calls.
vi.mock('./sms/native.js', () => ({
  getNativeSmsModule: () => nativeState.module,
  supportsAutoCapture: (module: { startRetriever?: unknown } | null) =>
    typeof module?.startRetriever === 'function',
}));

const APP_HASH = 'FA+9qCX9VSu';
const TEMPLATE = 'Your DIDWW code is {{CODE}}. Do not share it.';
const RETRIEVER_BODY = `<#> Your DIDWW code is 123456. Do not share it.\n${APP_HASH}`;
const SMS_START: StartInput = { destination: '+1 555 000 1111', deliveryMethod: 'sms' };

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function verificationBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      id: 'ver-1',
      destination: '15550001111',
      delivery_method: 'sms',
      fee: '0.0450',
      status: 'pending',
      error_code: null,
      error_detail: null,
      expires_at: inMinutes(10),
      sms: { template: TEMPLATE, interception_timeout: 600, app_hash: APP_HASH },
      ...overrides,
    },
  });
}

function errorBody(code: string, detail: string | null = 'prose'): string {
  return JSON.stringify({ errors: [{ code, detail }] });
}

function ok(body: string): HttpResponse {
  return { status: 200, headers: {}, body };
}

function rejected(status: number, body: string): HttpResponse {
  return { status, headers: {}, body };
}

type ScriptEntry = HttpResponse | ((request: HttpRequest) => HttpResponse);

function abortedPromise(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** `fakeTransport` records and scripts as usual; the response is withheld until `release()`. */
function heldTransport(script: readonly ScriptEntry[]): {
  transport: Transport;
  requests: readonly HttpRequest[];
  release: () => void;
} {
  const { transport, requests } = fakeTransport(script);
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const held: Transport = async (request) => {
    const scripted = transport(request);
    // The abort path never awaits it, and an exhausted script rejects.
    void scripted.catch(() => undefined);
    await Promise.race([gate, abortedPromise(request.signal)]);
    if (request.signal?.aborted === true) {
      throw new TransportError('The request was aborted.');
    }
    return scripted;
  };
  return { transport: held, requests, release: open };
}

/**
 * Like {@link heldTransport} but deaf to the signal, so a run can outlive the reset that abandoned
 * it. Each index in `heldIndexes` answers only once `release(index)` is called.
 */
function laggedTransport(
  script: readonly ScriptEntry[],
  heldIndexes: readonly number[],
): {
  transport: Transport;
  requests: readonly HttpRequest[];
  release: (index: number) => void;
} {
  const { transport, requests } = fakeTransport(script);
  const resolvers = new Map<number, () => void>();
  const gates = new Map<number, Promise<void>>();
  for (const index of heldIndexes) {
    gates.set(index, new Promise<void>((resolve) => resolvers.set(index, resolve)));
  }
  let issued = 0;
  const lagged: Transport = async (request) => {
    const index = issued;
    issued += 1;
    const scripted = transport(request);
    void scripted.catch(() => undefined);
    const gate = gates.get(index);
    if (gate !== undefined) {
      await gate;
    }
    return scripted;
  };
  return {
    transport: lagged,
    requests,
    release: (index) => {
      resolvers.get(index)?.();
    },
  };
}

function clientFor(transport: Transport): VerificationClient {
  return new VerificationClient({
    auth: publicAuth('app-key'),
    baseUrl: 'https://verification.example',
    transport,
  });
}

interface Box {
  controller: VerificationController | null;
}

function controllerOf(box: Box): VerificationController {
  const controller = box.controller;
  if (controller === null) {
    throw new Error('the host has not rendered');
  }
  return controller;
}

function requestAt(requests: readonly HttpRequest[], index: number): HttpRequest {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`no request at index ${index}`);
  }
  return request;
}

function Host(props: {
  readonly client: VerificationClient;
  readonly box: Box;
  readonly autoCapture?: boolean;
  readonly startOnMount?: StartInput;
}): React.JSX.Element {
  const controller = useVerification({
    client: props.client,
    ...(props.autoCapture === undefined ? {} : { autoCapture: props.autoCapture }),
  });
  props.box.controller = controller;

  const startOnMount = props.startOnMount;
  useEffect(() => {
    if (startOnMount !== undefined) {
      controller.start(startOnMount);
    }
  }, []);

  return <div data-testid="state">{controller.state.kind}</div>;
}

/** One macrotask, inside `act`: long enough for a deferred teardown to have fired. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function fakeNative(getAppHash: () => Promise<string> = () => Promise.resolve(APP_HASH)) {
  const listeners: Array<(payload: SmsReceivedEvent) => void> = [];
  const remove = vi.fn(() => {
    listeners.length = 0;
  });
  const hash = vi.fn(getAppHash);
  const start = vi.fn(() => Promise.resolve());
  const stop = vi.fn(() => Promise.resolve());
  const module: NativeSmsModule = {
    getAppHash: hash,
    startRetriever: start,
    stopRetriever: stop,
    addListener: (_event, listener) => {
      listeners.push(listener);
      return { remove };
    },
  };
  return {
    module,
    hash,
    start,
    stop,
    remove,
    emit: (message: string): void => {
      for (const listener of [...listeners]) {
        listener({ message });
      }
    },
  };
}

function decodedBody(request: HttpRequest): unknown {
  return JSON.parse(request.body ?? 'null');
}

beforeEach(() => {
  nativeState.module = null;
});

afterEach(() => {
  cleanup();
  nativeState.module = null;
  vi.restoreAllMocks();
});

describe('useVerification: starting', () => {
  it('issues one start request and lands on awaitingInput', async () => {
    const { transport, requests } = fakeTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    expect(requests).toHaveLength(1);
    expect(requestAt(requests, 0).method).toBe('POST');
    expect(requestAt(requests, 0).path).toBe('/api/v1/verifications');
    const state = controllerOf(box).state;
    expect(state.kind).toBe('awaitingInput');
    if (state.kind === 'awaitingInput') {
      expect(state.verificationId).toBe('ver-1');
      expect(state.fee).toBe('0.0450');
      expect(state.lastError).toBeNull();
    }
    expect(screen.getByTestId('state').textContent).toBe('awaitingInput');
  });

  it('rejects a second start in the same mount with already_running and issues no request', async () => {
    const { transport, requests } = heldTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} />);
    await act(async () => {
      controllerOf(box).start(SMS_START);
      controllerOf(box).start(SMS_START);
    });

    expect(requests).toHaveLength(1);
    const state = controllerOf(box).state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason).toEqual({ source: 'sdk', error: { code: 'already_running' } });
    }
  });

  it('reports a transport failure as failed/sdk/transport', async () => {
    const { transport } = fakeTransport([
      () => {
        throw new TransportError('network down');
      },
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    const state = controllerOf(box).state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason).toEqual({
        source: 'sdk',
        error: { code: 'transport', message: 'network down' },
      });
    }
  });

  it('reports a thrown value that is not an Error', async () => {
    const transport: Transport = () => Promise.reject('the bridge went away');
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    const state = controllerOf(box).state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason).toEqual({
        source: 'sdk',
        error: { code: 'transport', message: 'the bridge went away' },
      });
    }
  });

  it('reports an undecodable success body as failed/sdk/decoding', async () => {
    const { transport } = fakeTransport([ok('<html>not this api</html>')]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    const state = controllerOf(box).state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason.source).toBe('sdk');
      expect(state.reason.error.code).toBe('decoding');
    }
  });

  it('keeps the status of an error response whose body was never this API envelope', async () => {
    const { transport } = fakeTransport([rejected(502, '<html>bad gateway</html>')]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    const state = controllerOf(box).state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed' && state.reason.source === 'api') {
      expect(state.reason.error).toEqual({ code: 'internal_error', detail: 'HTTP 502' });
    }
  });
});

describe('useVerification: StrictMode and teardown', () => {
  it('issues exactly one start request under StrictMode', async () => {
    const { transport, requests, release } = heldTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(
      <StrictMode>
        <Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />
      </StrictMode>,
    );
    await flush();
    release();
    await flush();

    expect(requests).toHaveLength(1);
  });

  // The count above passes for a hook that issues one request and then aborts it, which is the
  // whole trap: survival is a separate assertion.
  it('keeps that request alive across the StrictMode remount and resolves it into state', async () => {
    const { transport, requests, release } = heldTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(
      <StrictMode>
        <Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />
      </StrictMode>,
    );
    await flush();

    expect(requestAt(requests, 0).signal?.aborted).toBe(false);

    release();
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
  });

  it('aborts the in-flight request on a real unmount', async () => {
    const { transport, requests } = heldTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    const view = render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    expect(requestAt(requests, 0).signal?.aborted).toBe(false);

    view.unmount();
    await flush();

    expect(requestAt(requests, 0).signal?.aborted).toBe(true);
  });
});

describe('useVerification: submitting', () => {
  it('sends exactly one report for a double submit', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody()),
      ok(verificationBody({ status: 'verified' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    await act(async () => {
      controllerOf(box).submit('123456');
      controllerOf(box).submit('123456');
    });

    expect(requests).toHaveLength(2);
    expect(requestAt(requests, 1).method).toBe('PUT');
    expect(controllerOf(box).state.kind).toBe('verified');
  });

  it('buffers a submit made before the verification is live, without throwing', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody()),
      ok(verificationBody({ status: 'verified' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} />);
    await act(async () => {
      expect(() => controllerOf(box).submit('123456')).not.toThrow();
    });

    expect(requests).toHaveLength(0);
    expect(controllerOf(box).state.kind).toBe('idle');

    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    expect(requests).toHaveLength(2);
    expect(decodedBody(requestAt(requests, 1))).toEqual({
      data: { delivery_method: 'sms', code: '123456' },
    });
    expect(controllerOf(box).state.kind).toBe('verified');
  });

  it('drops a buffered submit when the start never produced a live verification', async () => {
    const { transport, requests } = fakeTransport([
      rejected(402, errorBody('balance_insufficient')),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} />);
    await act(async () => {
      controllerOf(box).submit('123456');
    });
    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    expect(requests).toHaveLength(1);
    expect(controllerOf(box).state.kind).toBe('failed');
  });

  it('does not let a report that lands after a reset decide the next verification', async () => {
    const { transport, requests, release } = laggedTransport(
      [
        ok(verificationBody()),
        ok(verificationBody({ status: 'verified' })),
        ok(verificationBody({ id: 'ver-2' })),
      ],
      [1],
    );
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    await act(async () => {
      controllerOf(box).submit('123456');
    });
    expect(controllerOf(box).state.kind).toBe('submitting');

    await act(async () => {
      controllerOf(box).reset();
    });
    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    release(1);
    await flush();

    expect(requests).toHaveLength(3);
    const state = controllerOf(box).state;
    // Reporting the abandoned row's success here would admit the caller on a verification the
    // host walked away from.
    expect(state.kind).toBe('awaitingInput');
    if (state.kind === 'awaitingInput') {
      expect(state.verificationId).toBe('ver-2');
    }
  });

  it('does not attach a report failure that lands after a reset to the next verification', async () => {
    const { transport, release } = laggedTransport(
      [
        ok(verificationBody()),
        rejected(422, errorBody('code_invalid')),
        ok(verificationBody({ id: 'ver-2' })),
      ],
      [1],
    );
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    await act(async () => {
      controllerOf(box).submit('000000');
    });
    await act(async () => {
      controllerOf(box).reset();
    });
    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    release(1);
    await flush();

    const state = controllerOf(box).state;
    expect(state.kind).toBe('awaitingInput');
    if (state.kind === 'awaitingInput') {
      expect(state.verificationId).toBe('ver-2');
      expect(state.lastError).toBeNull();
    }
  });

  it('does not let a report that lands after a reset unlock the single-flight for a live one', async () => {
    const { transport, requests, release } = laggedTransport(
      [
        ok(verificationBody()),
        ok(verificationBody({ status: 'verified' })),
        ok(verificationBody({ id: 'ver-2' })),
        ok(verificationBody({ id: 'ver-2', status: 'verified' })),
      ],
      [1, 3],
    );
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    await act(async () => {
      controllerOf(box).submit('123456');
    });
    await act(async () => {
      controllerOf(box).reset();
    });
    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();
    await act(async () => {
      controllerOf(box).submit('222222');
    });

    release(1);
    await flush();

    await act(async () => {
      controllerOf(box).submit('999999');
    });

    expect(requests).toHaveLength(4);

    release(3);
    await flush();
    expect(controllerOf(box).state.kind).toBe('verified');
  });

  it('drops a submit made after a terminal outcome instead of carrying it to the next start', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody()),
      ok(verificationBody({ status: 'verified' })),
      ok(verificationBody({ id: 'ver-2' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    await act(async () => {
      controllerOf(box).submit('123456');
    });
    expect(controllerOf(box).state.kind).toBe('verified');

    await act(async () => {
      controllerOf(box).submit('999999');
    });
    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    expect(requests).toHaveLength(3);
    expect(controllerOf(box).state.kind).toBe('awaitingInput');
  });

  it('reports a known channel through the closed type', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody({ delivery_method: 'callout', sms: null })),
      ok(verificationBody({ delivery_method: 'callout', sms: null, status: 'verified' })),
    ]);
    const client = clientFor(transport);
    const guarded = vi.spyOn(client, 'reportVerification');
    const raw = vi.spyOn(client, 'reportVerificationRaw');
    const box: Box = { controller: null };

    render(
      <Host
        client={client}
        box={box}
        startOnMount={{ destination: '+15550001111', deliveryMethod: 'callout' }}
      />,
    );
    await flush();
    await act(async () => {
      controllerOf(box).submit('4321');
    });

    expect(guarded).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
    expect(decodedBody(requestAt(requests, 1))).toEqual({
      data: { delivery_method: 'callout', code: '4321' },
    });
    expect(controllerOf(box).state.kind).toBe('verified');
  });

  it('reports a channel this release does not model through the escape hatch', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody({ delivery_method: 'whatsapp', sms: null })),
      ok(verificationBody({ delivery_method: 'whatsapp', sms: null, status: 'verified' })),
    ]);
    const client = clientFor(transport);
    const guarded = vi.spyOn(client, 'reportVerification');
    const raw = vi.spyOn(client, 'reportVerificationRaw');
    const box: Box = { controller: null };

    render(
      <Host
        client={client}
        box={box}
        startOnMount={{ destination: '+15550001111', deliveryMethod: 'whatsapp' }}
      />,
    );
    await flush();
    await act(async () => {
      controllerOf(box).submit('9999');
    });

    expect(raw).toHaveBeenCalledTimes(1);
    expect(guarded).not.toHaveBeenCalled();
    // An unmodelled channel is reported with `code`, exactly as the sibling SDKs do.
    expect(decodedBody(requestAt(requests, 1))).toEqual({
      data: { delivery_method: 'whatsapp', code: '9999' },
    });
    expect(controllerOf(box).state.kind).toBe('verified');
  });

  it('returns to awaitingInput with lastError on a recoverable failure and accepts another value', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody()),
      rejected(422, errorBody('code_invalid', 'The code is invalid.')),
      ok(verificationBody({ status: 'verified' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    await act(async () => {
      controllerOf(box).submit('000000');
    });

    const recovered = controllerOf(box).state;
    expect(recovered.kind).toBe('awaitingInput');
    if (recovered.kind === 'awaitingInput') {
      expect(recovered.lastError).toEqual({ code: 'code_invalid', detail: 'The code is invalid.' });
      expect(recovered.verificationId).toBe('ver-1');
    }

    await act(async () => {
      controllerOf(box).submit('123456');
    });

    expect(requests).toHaveLength(3);
    expect(controllerOf(box).state.kind).toBe('verified');
  });
});

describe('useVerification: reattaching and resetting', () => {
  it('resumes the newest verification for a number', async () => {
    const { transport, requests } = fakeTransport([ok(verificationBody({ id: 'ver-9' }))]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} />);
    await act(async () => {
      controllerOf(box).resume({ destination: '+1 555 000 1111', deliveryMethod: 'sms' });
    });
    await flush();

    expect(requestAt(requests, 0).method).toBe('GET');
    expect(requestAt(requests, 0).path).toBe('/api/v1/verifications/by_number/15550001111');
    const state = controllerOf(box).state;
    expect(state.kind).toBe('awaitingInput');
    if (state.kind === 'awaitingInput') {
      expect(state.verificationId).toBe('ver-9');
    }
  });

  it('resumes by id', async () => {
    const { transport, requests } = fakeTransport([ok(verificationBody({ id: 'ver-9' }))]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} />);
    await act(async () => {
      controllerOf(box).resumeById({ verificationId: 'ver-9', deliveryMethod: 'sms' });
    });
    await flush();

    expect(requestAt(requests, 0).method).toBe('GET');
    expect(requestAt(requests, 0).path).toBe('/api/v1/verifications/ver-9');
    expect(controllerOf(box).state.kind).toBe('awaitingInput');
  });

  it('ignores a start that succeeds after a reset', async () => {
    const { transport, release } = laggedTransport([ok(verificationBody())], [0]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await act(async () => {
      controllerOf(box).reset();
    });
    release(0);
    await flush();

    expect(controllerOf(box).state.kind).toBe('idle');
  });

  it('ignores a start that fails after a reset', async () => {
    const { transport, release } = laggedTransport(
      [rejected(500, errorBody('internal_error'))],
      [0],
    );
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await act(async () => {
      controllerOf(box).reset();
    });
    release(0);
    await flush();

    expect(controllerOf(box).state.kind).toBe('idle');
  });

  it('returns to idle on reset and allows a fresh start', async () => {
    const { transport, requests } = fakeTransport([
      ok(verificationBody()),
      ok(verificationBody({ id: 'ver-2' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    expect(controllerOf(box).state.kind).toBe('awaitingInput');

    await act(async () => {
      controllerOf(box).reset();
    });
    expect(controllerOf(box).state.kind).toBe('idle');

    await act(async () => {
      controllerOf(box).start(SMS_START);
    });
    await flush();

    expect(requests).toHaveLength(2);
    expect(controllerOf(box).state.kind).toBe('awaitingInput');
  });
});

describe('useVerification: SMS auto-capture', () => {
  it('arms after a successful start and feeds a captured value into the machine', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    expect(native.hash).toHaveBeenCalledTimes(1);
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: {
        destination: '+1 555 000 1111',
        delivery_method: 'sms',
        sms: { app_hash: APP_HASH },
      },
    });
    expect(native.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      native.emit(RETRIEVER_BODY);
    });

    const state = controllerOf(box).state;
    expect(state.kind).toBe('captured');
    if (state.kind === 'captured') {
      expect(state.value).toBe('123456');
    }
  });

  it('disarms on a terminal outcome', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport } = fakeTransport([
      ok(verificationBody()),
      ok(verificationBody({ status: 'verified' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    expect(native.stop).not.toHaveBeenCalled();

    await act(async () => {
      controllerOf(box).submit('123456');
    });

    expect(controllerOf(box).state.kind).toBe('verified');
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.remove).toHaveBeenCalledTimes(1);
  });

  it('disarms on unmount', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport } = fakeTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    const view = render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();

    view.unmount();
    await flush();

    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('disarms when the verification expires', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport } = fakeTransport([
      ok(verificationBody({ expires_at: new Date(Date.now() + 60).toISOString() })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    expect(native.start).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(native.stop).toHaveBeenCalledTimes(1);
    });
    // The interception budget is far longer, so the disarm came from `expiresAt`.
    expect(controllerOf(box).state.kind).toBe('awaitingInput');
  });

  it('disarms at once for a row that is already past its deadline', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport } = fakeTransport([
      ok(verificationBody({ expires_at: new Date(Date.now() - 1000).toISOString() })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('stays armed for a deadline beyond the timer range', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport } = fakeTransport([
      ok(verificationBody({ expires_at: '2099-01-01T00:00:00Z' })),
    ]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();
    await flush();

    expect(native.stop).not.toHaveBeenCalled();
  });

  it('never arms and never reads the app hash when autoCapture is false', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(
      <Host client={clientFor(transport)} box={box} autoCapture={false} startOnMount={SMS_START} />,
    );
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
    expect(native.hash).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: { destination: '+1 555 000 1111', delivery_method: 'sms' },
    });
  });

  it('never arms and never reads the app hash on a channel that is not sms', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([
      ok(verificationBody({ delivery_method: 'callout', sms: null })),
    ]);
    const box: Box = { controller: null };

    render(
      <Host
        client={clientFor(transport)}
        box={box}
        startOnMount={{ destination: '+15550001111', deliveryMethod: 'callout' }}
      />,
    );
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
    expect(native.hash).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: { destination: '+15550001111', delivery_method: 'callout' },
    });
  });

  it('passes sms options through on a channel that is not sms, without reading the app hash', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([
      ok(verificationBody({ delivery_method: 'callout', sms: null })),
    ]);
    const box: Box = { controller: null };

    render(
      <Host
        client={clientFor(transport)}
        box={box}
        startOnMount={{
          destination: '+15550001111',
          deliveryMethod: 'callout',
          sms: { languages: ['en-US'] },
        }}
      />,
    );
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
    expect(native.hash).not.toHaveBeenCalled();
    // Core emits the channel's own block only, so the options reach it and are dropped there.
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: { destination: '+15550001111', delivery_method: 'callout' },
    });
  });

  it('passes callout options through, and reads no app hash for that channel', async () => {
    const native = fakeNative();
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([
      ok(
        verificationBody({ delivery_method: 'callout', sms: null, callout: { language: 'pt-PT' } }),
      ),
    ]);
    const box: Box = { controller: null };

    render(
      <Host
        client={clientFor(transport)}
        box={box}
        startOnMount={{
          destination: '+15550001111',
          deliveryMethod: 'callout',
          callout: { languages: ['pt-BR', 'pt-PT'] },
        }}
      />,
    );
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
    expect(native.hash).not.toHaveBeenCalled();
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: {
        destination: '+15550001111',
        delivery_method: 'callout',
        callout: { languages: ['pt-BR', 'pt-PT'] },
      },
    });
  });

  it('starts the verification anyway when the device has no app hash', async () => {
    const native = fakeNative(() => Promise.reject(new Error('no module')));
    nativeState.module = native.module;
    const { transport, requests } = fakeTransport([ok(verificationBody())]);
    const box: Box = { controller: null };

    render(<Host client={clientFor(transport)} box={box} startOnMount={SMS_START} />);
    await flush();

    expect(controllerOf(box).state.kind).toBe('awaitingInput');
    expect(native.start).not.toHaveBeenCalled();
    expect(decodedBody(requestAt(requests, 0))).toEqual({
      data: { destination: '+1 555 000 1111', delivery_method: 'sms' },
    });
  });
});
