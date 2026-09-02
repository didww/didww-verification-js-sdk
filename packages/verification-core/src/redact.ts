// Six is the shortest run worth hiding: a by-number route carries the destination in the path
// itself, and the generated code is six digits. An HTTP status and a port stay readable.
const DIGIT_RUN = /[0-9]{6,}/g;

const MASK = '[redacted]';

/** Masks every run of six or more digits. Applied to every line the client hands its logger. */
export function redact(line: string): string {
  return line.replace(DIGIT_RUN, MASK);
}
