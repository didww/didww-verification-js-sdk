import type { HttpRequest, HttpResponse, Transport } from '../transport.js';

type ScriptEntry = HttpResponse | ((request: HttpRequest) => HttpResponse);

/**
 * A scripted {@link Transport} double for tests: request N consumes script entry N (a fixed
 * response, or a function of the request), and every request is recorded verbatim and in order in
 * `requests`. Calling past the end throws rather than returning a default, since an extra request
 * is usually the bug the test exists to catch.
 */
export function fakeTransport(script: ReadonlyArray<ScriptEntry>): {
  transport: Transport;
  requests: readonly HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  let cursor = 0;

  const transport: Transport = async (request) => {
    requests.push(request);
    if (cursor >= script.length) {
      throw new Error(
        `fakeTransport: no response scripted for request ${cursor + 1} ` +
          `(${request.method} ${request.path}); the script only had ${script.length} entr${script.length === 1 ? 'y' : 'ies'}.`,
      );
    }
    const entry = script[cursor]!;
    cursor += 1;
    return typeof entry === 'function' ? entry(request) : entry;
  };

  return { transport, requests };
}
