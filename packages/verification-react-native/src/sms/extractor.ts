const PLACEHOLDER = '{{CODE}}';

// Hand-rolled: `RegExp.escape` is absent on this repo's Node floor and on Hermes, and a
// feature-detected fallback would take the untested path on every device.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Recovers the delivered code from a received SMS body, using the template it was rendered from. */
export function extractCode(template: string | null | undefined, body: string): string | null {
  if (!template) return null;
  const split = template.indexOf(PLACEHOLDER);
  if (split === -1) return null;

  const before = escapeRegExp(template.slice(0, split));
  const after = escapeRegExp(template.slice(split + PLACEHOLDER.length));

  // Unanchored because the delivered body is wider than the template on both sides: the Retriever
  // protocol adds `<#>` and a trailing app hash, and carriers add text of their own. `\d+` not
  // `.+`, which would swallow that hash; no length bound, because code length is the server's.
  const [, code = null] = body.match(new RegExp(`${before}(\\d+)${after}`)) ?? [];
  return code;
}
