export interface ParsedAuthorization {
  readonly key: string | null;
  readonly signature: string | null;
}

const SCHEME = 'Application ';
const UNPARSED: ParsedAuthorization = { key: null, signature: null };

/**
 * Splits an inbound `Application <key>:<signature>` (signed) or `Application <key>` (public)
 * header. Any other form yields two nulls rather than throwing.
 */
export function parseAuthorization(header: string | null | undefined): ParsedAuthorization {
  // Case-sensitive, and no leading whitespace tolerated: this matches the server that emits the
  // header, though RFC 9110 would allow any scheme casing.
  if (typeof header !== 'string' || !header.startsWith(SCHEME)) return UNPARSED;

  const token = header.slice(SCHEME.length);
  const separator = token.indexOf(':');
  if (separator === -1) return token === '' ? UNPARSED : { key: token, signature: null };

  // Dispatch is by the FIRST colon; a signature may contain further ones. An empty key or an
  // empty signature is malformed rather than public — reading a truncated signed header as an
  // unsigned one would silently downgrade it.
  if (separator === 0 || separator === token.length - 1) return UNPARSED;
  return { key: token.slice(0, separator), signature: token.slice(separator + 1) };
}
