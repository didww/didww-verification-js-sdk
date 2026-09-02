import { ConfigurationError } from './errors.js';

/**
 * The by-number path segment: ASCII digits only, matching the server's own normalisation. Nothing
 * is percent-encoded and nothing is transliterated — a surviving `.` reads as a format suffix and
 * would silently address a different resource, and a Unicode decimal digit is not an ASCII one.
 */
export function digitsOf(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits === '') {
    throw new ConfigurationError('Destination contains no digits.');
  }
  return digits;
}
