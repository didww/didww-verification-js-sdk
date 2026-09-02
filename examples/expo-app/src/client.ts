import { VerificationClient } from '@didww/verification-core';

import { authProvider, baseUrl } from './config';

// Constructed once, at module scope: `useVerification` takes the instance as an option and a client
// rebuilt on every render would restart the run it is driving.
let instance: VerificationClient | null = null;
let failure: string | null = null;

try {
  instance = new VerificationClient({ auth: authProvider(), baseUrl });
} catch (error) {
  // A blank key or secret throws here rather than on the first request, so the app reports it
  // instead of crashing at launch.
  failure = error instanceof Error ? error.message : String(error);
}

export const client = instance;
export const clientError = failure;
