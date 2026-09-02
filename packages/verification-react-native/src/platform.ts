/** Spread onto the host's code input so both platforms' keyboards offer the incoming code. */
export const otpInputProps = {
  textContentType: 'oneTimeCode',
  autoComplete: 'sms-otp',
  keyboardType: 'number-pad',
} as const;
