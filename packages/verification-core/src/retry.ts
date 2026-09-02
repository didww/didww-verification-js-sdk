import { isApiError, isDidwwError } from './errors.js';
import type { RetryPolicy } from './options.js';

export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = { attempts: 2, baseDelayMs: 200 };

/** Internal seam so backoff is testable without waiting. Not reachable from `ClientOptions`. */
export interface RetrySeam {
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const defaultRetrySeam: RetrySeam = {
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  random: () => Math.random(),
};

/**
 * Name-branded rather than `instanceof`: a caller-supplied transport may come from a second
 * installed copy of this package, whose `TransportError` is a different class object.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (isApiError(error)) {
    return error.status >= 500;
  }
  return isDidwwError(error) && error.name === 'TransportError';
}

/** Exponential, then jittered down to somewhere in the upper half of the window. */
export function backoffDelayMs(attempt: number, baseDelayMs: number, random: () => number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

function attemptsOf(policy: RetryPolicy): number {
  return Number.isFinite(policy.attempts) ? Math.max(1, Math.floor(policy.attempts)) : 1;
}

/**
 * Runs `operation` up to `policy.attempts` times, retrying only a transport failure or a 5xx.
 *
 * Safe for a GET and for nothing else: a create or a report that timed out may still have landed on
 * the server, so retrying one double-charges and supersedes. The single call site enforces that.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  seam: RetrySeam = defaultRetrySeam,
): Promise<T> {
  const attempts = attemptsOf(policy);
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isRetryableFailure(error)) {
        throw error;
      }
      const delay = backoffDelayMs(attempt, baseDelayMs, seam.random);
      if (delay > 0) {
        await seam.sleep(delay);
      }
    }
  }
}
