import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors.js';
import { digitsOf } from './phone-number.js';

describe('digitsOf', () => {
  it('strips every non-digit, the leading + included', () => {
    expect(digitsOf('+49 (151) 1.234')).toBe('491511234');
  });

  it.each([
    ['+37112345678', '37112345678'],
    ['+371-1234-5678', '37112345678'],
    ['00 371 12345678', '0037112345678'],
    ['+371.12345678', '37112345678'],
  ])('reduces %j to digits', (input, expected) => {
    expect(digitsOf(input)).toBe(expected);
  });

  it('preserves digit order', () => {
    expect(digitsOf('9a8b7c6d5e4f3g2h1i0')).toBe('9876543210');
  });

  it('drops Unicode decimal digits rather than transliterating them', () => {
    expect(digitsOf('٤4４')).toBe('4');
  });

  it.each([
    ['no digits at all', '+()- '],
    ['letters only', 'not-a-number'],
    ['the empty string', ''],
    ['Arabic-Indic digits', '٤٩١٥١١٢٣٤'],
    ['fullwidth digits', '４９１５１１２３４'],
  ])('throws ConfigurationError on %s', (_label, input) => {
    expect(() => digitsOf(input)).toThrow(ConfigurationError);
  });

  it('keeps the destination out of the error message', () => {
    expect(() => digitsOf('٤٩١٥١')).toThrow(/^Destination contains no digits\.$/);
  });
});
