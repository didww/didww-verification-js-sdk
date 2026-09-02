import { expressCallbackHandler, type CallbackHandler } from '@didww/verification-node';

import type { Config } from './config.ts';

/**
 * The inbound gate: the API asks whether to start a verification, and the answer decides it once —
 * there is no retry, and any answer it cannot read is taken as a denial.
 */
export function callbackHandler(config: Config): CallbackHandler {
  return expressCallbackHandler({
    // A resolver, not a fixed secret: one endpoint may serve several applications, and the key
    // is in the Authorization header of each callback.
    secret: (key) => config.applications.get(key) ?? null,

    // The path of the REGISTERED callback URL, never the one this request arrived on. That path is
    // the EMPTY STRING for a bare `https://example.com`, so such a registration needs `path: ''`,
    // not `'/'`.
    path: config.callbackSignedPath,

    decide: (payload) => {
      const deny =
        config.denyDestinationPrefix !== '' &&
        payload.data.destination.startsWith(config.denyDestinationPrefix);
      console.log(
        `callback ${payload.data.id} ${payload.data.deliveryMethod} -> ${deny ? 'deny' : 'allow'}`,
      );
      return { action: deny ? 'deny' : 'allow' };
    },

    // Logged, never answered: the adapter replies with a status and no body on purpose, because
    // echoing the reason would turn the endpoint into an oracle for which application keys exist.
    onRejected: (reason) => {
      console.warn(`callback rejected: ${reason}`);
    },
  });
}
