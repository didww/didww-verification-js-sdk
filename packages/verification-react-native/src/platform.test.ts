import { expect, test } from 'vitest';

import { otpInputProps } from './platform.js';

test('carries the three input props verbatim', () => {
  expect(otpInputProps).toEqual({
    textContentType: 'oneTimeCode',
    autoComplete: 'sms-otp',
    keyboardType: 'number-pad',
  });
});

test('is typed as those exact literals', () => {
  // Widening any of these to `string` fails tsc here rather than at a consumer's call site.
  const textContentType: 'oneTimeCode' = otpInputProps.textContentType;
  const autoComplete: 'sms-otp' = otpInputProps.autoComplete;
  const keyboardType: 'number-pad' = otpInputProps.keyboardType;
  expect([textContentType, autoComplete, keyboardType]).toEqual([
    'oneTimeCode',
    'sms-otp',
    'number-pad',
  ]);
});
