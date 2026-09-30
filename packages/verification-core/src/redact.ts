// Four is the shortest run worth hiding: a by-number route carries the destination in the path
// itself, and the generated code is 4–8 digits, chosen by the server.
// A canonical UUID is matched first and kept: it is an identifier, not a secret, and masking part
// of one leaves a token still shaped like an id that no longer equals any record.
const UUID_OR_DIGIT_RUN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4,}/gi;

// Non-global on purpose: tested per match, so there is no lastIndex to carry between calls.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MASK = '[redacted]';

/** Masks every run of four or more digits outside a UUID. Applied to every line the client logs. */
export function redact(line: string): string {
  return line.replace(UUID_OR_DIGIT_RUN, (match) => (UUID.test(match) ? match : MASK));
}
