import { describe, expect, it, vi } from 'vitest';
import {
  DecodingError,
  DidwwError,
  ServerError,
  TransportError,
  ValidationError,
} from './errors.js';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  defaultRetrySeam,
  isRetryableFailure,
  withRetry,
  type RetrySeam,
} from './retry.js';

/** Records what it was asked to wait for instead of waiting. */
function recordingSeam(random = 1): { seam: RetrySeam; waited: number[] } {
  const waited: number[] = [];
  return {
    seam: {
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
      random: () => random,
    },
    waited,
  };
}

describe('DEFAULT_RETRY_POLICY', () => {
  it('is two attempts with a 200ms base', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ attempts: 2, baseDelayMs: 200 });
  });
});

describe('isRetryableFailure', () => {
  it('is true for a transport failure', () => {
    expect(isRetryableFailure(new TransportError('network down'))).toBe(true);
  });

  it('is true for a 5xx', () => {
    expect(isRetryableFailure(new ServerError(503, [], ''))).toBe(true);
  });

  it('is false for a 4xx', () => {
    expect(isRetryableFailure(new ValidationError(422, [], ''))).toBe(false);
  });

  it.each([new DecodingError('not JSON', '<html>'), new Error('boom'), undefined, 'nope'])(
    'is false for %s',
    (value) => {
      expect(isRetryableFailure(value)).toBe(false);
    },
  );

  it('holds for a transport failure from a second copy of the package', () => {
    // `instanceof` is false against a foreign class object; the name brand is not.
    class ForeignTransportError extends DidwwError {
      override readonly name = 'TransportError';
    }
    const foreign = new ForeignTransportError('network down');
    expect(foreign instanceof TransportError).toBe(false);
    expect(isRetryableFailure(foreign)).toBe(true);
  });
});

describe('backoffDelayMs', () => {
  it('doubles per attempt', () => {
    expect(backoffDelayMs(1, 200, () => 1)).toBe(200);
    expect(backoffDelayMs(2, 200, () => 1)).toBe(400);
    expect(backoffDelayMs(3, 200, () => 1)).toBe(800);
  });

  it('jitters down to half the window', () => {
    expect(backoffDelayMs(1, 200, () => 0)).toBe(100);
    expect(backoffDelayMs(2, 200, () => 0.5)).toBe(300);
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const { seam, waited } = recordingSeam();
    const operation = vi.fn(() => Promise.resolve('ok'));

    await expect(withRetry(operation, { attempts: 3 }, seam)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(waited).toEqual([]);
  });

  it('retries a retryable failure up to `attempts` and then rethrows the last error', async () => {
    const { seam, waited } = recordingSeam();
    const failure = new TransportError('network down');
    const operation = vi.fn(() => Promise.reject(failure));

    await expect(withRetry(operation, { attempts: 3, baseDelayMs: 200 }, seam)).rejects.toBe(
      failure,
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(waited).toEqual([200, 400]);
  });

  it('stops as soon as an attempt succeeds', async () => {
    const { seam } = recordingSeam();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TransportError('network down'))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, { attempts: 5, baseDelayMs: 0 }, seam)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure that is not retryable', async () => {
    const { seam } = recordingSeam();
    const failure = new ValidationError(422, [], '');
    const operation = vi.fn(() => Promise.reject(failure));

    await expect(withRetry(operation, { attempts: 10, baseDelayMs: 0 }, seam)).rejects.toBe(
      failure,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([1, 0, -3, Number.NaN])(
    'makes exactly one attempt for attempts: %s',
    async (attempts) => {
      const { seam } = recordingSeam();
      const operation = vi.fn(() => Promise.reject(new TransportError('network down')));

      await expect(withRetry(operation, { attempts, baseDelayMs: 0 }, seam)).rejects.toBeInstanceOf(
        TransportError,
      );
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back to the default base delay when the policy names none', async () => {
    const { seam, waited } = recordingSeam();
    const operation = vi.fn(() => Promise.reject(new TransportError('network down')));

    await expect(withRetry(operation, { attempts: 2 }, seam)).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(waited).toEqual([DEFAULT_RETRY_POLICY.baseDelayMs]);
  });

  it('skips the wait entirely when the computed delay is zero', async () => {
    const { seam, waited } = recordingSeam();
    const operation = vi.fn(() => Promise.reject(new TransportError('network down')));

    await expect(
      withRetry(operation, { attempts: 2, baseDelayMs: 0 }, seam),
    ).rejects.toBeInstanceOf(TransportError);
    expect(waited).toEqual([]);
  });
});

describe('defaultRetrySeam', () => {
  it('sleeps on a timer', async () => {
    vi.useFakeTimers();
    try {
      let slept = false;
      const sleeping = defaultRetrySeam.sleep(500).then(() => {
        slept = true;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(slept).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sleeping;
      expect(slept).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws jitter from Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      expect(defaultRetrySeam.random()).toBe(0.25);
    } finally {
      random.mockRestore();
    }
  });
});
