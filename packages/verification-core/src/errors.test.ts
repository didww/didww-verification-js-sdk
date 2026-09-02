import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BalanceInsufficientError,
  ChannelMismatchError,
  ConfigurationError,
  DecodingError,
  DidwwError,
  NotFoundError,
  ServerError,
  TransportError,
  UnauthorizedError,
  ValidationError,
  apiErrorForStatus,
  isApiError,
  isDidwwError,
  type ApiErrorItem,
} from './errors.js';

const envelope: readonly ApiErrorItem[] = [{ code: 'validation_failed', detail: 'Invalid.' }];
const body = '{"errors":[{"code":"validation_failed","detail":"Invalid."}]}';

describe('apiErrorForStatus', () => {
  it.each([
    [400, ValidationError],
    [401, UnauthorizedError],
    [402, BalanceInsufficientError],
    [404, NotFoundError],
    [422, ValidationError],
    [500, ServerError],
    [503, ServerError],
    [599, ServerError],
    [418, ApiError],
    [600, ApiError],
  ])('maps %i to %s', (status, expected) => {
    const error = apiErrorForStatus(status, envelope, body);
    expect(error.constructor).toBe(expected);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(status);
  });

  it('carries the envelope onto an unmodelled status rather than throwing', () => {
    const error = apiErrorForStatus(418, envelope, body);
    expect(error.code).toBe('validation_failed');
    expect(error.responseBody).toBe(body);
  });
});

describe('ApiError', () => {
  it('keeps every code in wire order and takes `code` from the first item', () => {
    const items: readonly ApiErrorItem[] = [
      { code: 'destination_blank', detail: 'Blank.' },
      { code: 'code_blank', detail: null },
    ];
    const error = new ApiError(422, items, body);

    expect(error.code).toBe('destination_blank');
    expect(error.codes).toEqual(['destination_blank', 'code_blank']);
    expect(error.errors).toEqual(items);
    expect(error.responseBody).toBe(body);
  });

  it('yields a null `code` for an empty envelope', () => {
    const error = new ApiError(500, [], '');
    expect(error.code).toBeNull();
    expect(error.codes).toEqual([]);
    expect(error.message).toBe('HTTP 500');
  });

  it('does not alias the array it was given', () => {
    const items: ApiErrorItem[] = [{ code: 'not_found', detail: null }];
    const error = new ApiError(404, items, body);
    items.push({ code: 'internal_error', detail: null });

    expect(error.errors).toHaveLength(1);
    expect(error.codes).toEqual(['not_found']);
  });
});

describe('the class tree', () => {
  const instances = [
    new DidwwError('x'),
    new ConfigurationError('x'),
    new ChannelMismatchError('x', 'sms'),
    new TransportError('x'),
    new DecodingError('x', '<html>'),
    new ApiError(500, envelope, body),
    new UnauthorizedError(401, envelope, body),
    new BalanceInsufficientError(402, envelope, body),
    new NotFoundError(404, envelope, body),
    new ValidationError(422, envelope, body),
    new ServerError(500, envelope, body),
  ] as const;

  it.each(instances.map((error) => [error.constructor.name, error] as const))(
    '%s names itself and stays an Error and a DidwwError',
    (name, error) => {
      expect(error.name).toBe(name);
      // `Object.setPrototypeOf` in the base constructor is what keeps these true once the emitted
      // code targets ES5; asserting them is the only way to notice if that step is dropped.
      expect(error).toBeInstanceOf(DidwwError);
      expect(error).toBeInstanceOf(Error);
      expect(isDidwwError(error)).toBe(true);
    },
  );

  it('reports the subclass name on a thrown-and-stringified error', () => {
    const error = new NotFoundError(404, [{ code: 'not_found', detail: null }], body);
    expect(String(error)).toBe('NotFoundError: HTTP 404: not_found');
  });

  it('carries the field each subclass is specified to expose', () => {
    expect(new ChannelMismatchError('x', 'sms').expected).toBe('sms');
    expect(new DecodingError('x', '<html>').body).toBe('<html>');
    const cause = new Error('socket hang up');
    expect(new TransportError('x', cause).cause).toBe(cause);
    expect(new TransportError('x').cause).toBeUndefined();
  });
});

describe('isDidwwError', () => {
  it('is false for anything the SDK did not throw', () => {
    expect(isDidwwError(new Error('boom'))).toBe(false);
    expect(isDidwwError('ApiError')).toBe(false);
    expect(isDidwwError(null)).toBe(false);
    expect(isDidwwError(undefined)).toBe(false);
    expect(isDidwwError({ name: 'UnauthorizedError', status: 401 })).toBe(false);
  });
});

describe('isApiError', () => {
  it('brands non-enumerably, under registry keys that are the cross-copy contract', () => {
    const error = new UnauthorizedError(401, envelope, body);
    const apiBrand = Symbol.for('@didww/verification-core#ApiError');
    const didwwBrand = Symbol.for('@didww/verification-core#DidwwError');

    // The literal key strings are asserted here on purpose: they are what two installed copies
    // agree on, so a rename has to break a test rather than silently break the guards.
    expect(Object.getOwnPropertyDescriptor(error, apiBrand)?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(error, didwwBrand)?.enumerable).toBe(false);
    expect(Object.getOwnPropertySymbols({ ...error })).toHaveLength(0);
  });

  it('separates the API branch from the rest of the tree', () => {
    expect(isApiError(new UnauthorizedError(401, envelope, body))).toBe(true);
    expect(isApiError(new ConfigurationError('x'))).toBe(false);
    expect(isApiError(new DidwwError('x'))).toBe(false);
    expect(isApiError({ status: 401, errors: [] })).toBe(false);
  });

  it('holds across a second copy of this module, where `instanceof` does not', async () => {
    // The query suffix makes the loader instantiate the module a second time, which is what two
    // installed copies of the package look like to a consumer catching an error from either.
    // @ts-expect-error -- the query suffix is a loader instruction; TypeScript cannot resolve it.
    const copy2 = (await import('./errors.js?copy=2')) as typeof import('./errors.js');

    expect(copy2.ApiError).not.toBe(ApiError);

    const fromCopy2 = copy2.apiErrorForStatus(401, envelope, body);

    // Both halves matter: without the `instanceof` assertion the guard test proves nothing,
    // because it would also pass if the two imports had collapsed to one module instance.
    expect(fromCopy2 instanceof UnauthorizedError).toBe(false);
    expect(fromCopy2 instanceof DidwwError).toBe(false);
    expect(isApiError(fromCopy2)).toBe(true);
    expect(isDidwwError(fromCopy2)).toBe(true);
    expect(fromCopy2.status).toBe(401);
    expect(fromCopy2.name).toBe('UnauthorizedError');

    // The converse direction: the brand is symmetric, not a one-way recognition of copy 2.
    const fromCopy1 = new UnauthorizedError(401, envelope, body);
    expect(fromCopy1 instanceof copy2.DidwwError).toBe(false);
    expect(copy2.isApiError(fromCopy1)).toBe(true);
    expect(copy2.isDidwwError(fromCopy1)).toBe(true);
  });
});
