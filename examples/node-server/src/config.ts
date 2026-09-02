// A `.env` file for local runs; a deployment injects the environment directly.
try {
  process.loadEnvFile();
} catch {
  // No .env file — the environment is expected to be set already.
}

export interface Config {
  readonly port: number;
  /** The API this server talks to. The mock by default; the sandbox or production in a deployment. */
  readonly baseUrl: string;
  /** The application this server signs its own API calls as. */
  readonly applicationKey: string;
  readonly applicationSecret: string;
  /** Every application this endpoint serves, keyed by application key. */
  readonly applications: ReadonlyMap<string, string>;
  /** Where express mounts the callback route — the path requests actually arrive on. */
  readonly callbackRoute: string;
  /** The path of the REGISTERED callback URL, which is what the API signed. */
  readonly callbackSignedPath: string;
  /** Destinations starting with this are denied by the gate. Empty denies nothing. */
  readonly denyDestinationPrefix: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required. Copy .env.example to .env, or set it in the environment.`,
    );
  }
  return value;
}

function parseApplications(raw: string): Map<string, string> {
  const applications = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf(':');
    const key = pair.slice(0, separator).trim();
    const secret = pair.slice(separator + 1).trim();
    if (separator === -1 || key === '' || secret === '') {
      throw new Error('APPLICATIONS must be a comma-separated list of `key:secret` pairs.');
    }
    applications.set(key, secret);
  }
  return applications;
}

export function readConfig(): Config {
  const applications = parseApplications(required('APPLICATIONS'));
  const applicationKey = required('APPLICATION_KEY');
  const applicationSecret = applications.get(applicationKey);
  if (applicationSecret === undefined) {
    throw new Error(`APPLICATION_KEY ${applicationKey} has no secret in APPLICATIONS.`);
  }

  const callbackRoute = process.env['CALLBACK_ROUTE'] ?? '/callbacks/didww';
  return {
    port: Number(process.env['PORT'] ?? 3300),
    baseUrl: process.env['BASE_URL'] ?? 'http://127.0.0.1:4000',
    applicationKey,
    applicationSecret,
    applications,
    callbackRoute,
    // Read separately, and `''` is a meaningful value: a proxy that rewrites the path makes the
    // registered path differ from the one requests arrive on.
    callbackSignedPath: process.env['CALLBACK_SIGNED_PATH'] ?? callbackRoute,
    denyDestinationPrefix: process.env['DENY_DESTINATION_PREFIX'] ?? '',
  };
}
