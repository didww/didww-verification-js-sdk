// The example backend as a PROCESS. `examples/node-server` is booted by its own entrypoint against
// `examples/mock-api`, and every flow below is driven over real sockets: a start the mock really
// signs a callback for, an answer the example really writes, and the verification the mock reaches
// as a result.
//
// The adapter oracle covers `expressCallbackHandler` as a function. This covers the wiring a
// customer copies -- the route the handler is mounted on, the environment it reads, and the four
// outcomes a misconfigured endpoint produces. Only the last two lines of that chain are visible
// from here: that the example's own env plumbing reaches the adapter intact, and that a wrong
// registered path denies rather than being quietly rescued.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMockApi } from '../examples/mock-api/src/server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'examples', 'node-server');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

const CODE = '123456';
const DENY_PREFIX = '1900';
const CALLBACK_ROUTE = '/callbacks/didww';

// Canonical URL-safe base64, which is what `Signer` accepts. One application per flow, so an
// endpoint's misconfiguration cannot leak into another flow's verdict.
const SECRETS = {
  allow: 'gRsKvkdrOL7WBmPnQx69bdaEI-u-VDC_RZLwkRMwG_k',
  bare: 'N_LcOP92KN816zeNCr7QBecO5JR1vuhZ-wAVeTrC5TM',
  wrongPath: 'IvZkI6-ySzvs6ZtTlooMhdYKfoj3k9RGeQAySzQSFv4',
  noCallback: 'QfhoxiHzoUA8aC-4LpVnk2Si-v-S98zcXycW_gr5SbI',
};

const KEYS = {
  allow: 'e2e_allow',
  bare: 'e2e_bare',
  wrongPath: 'e2e_wrong_path',
  noCallback: 'e2e_no_callback',
};

// Every example server resolves every key, which is also the multi-application resolver the
// example configures instead of a fixed secret.
const APPLICATIONS = Object.keys(KEYS)
  .map((name) => `${KEYS[name]}:${SECRETS[name]}`)
  .join(',');

/** Distinct free ports, all held open at once so two probes cannot return the same one. */
async function freePorts(count) {
  const probes = await Promise.all(
    Array.from({ length: count }, async () => {
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      return probe;
    }),
  );
  const ports = probes.map((probe) => probe.address().port);
  await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  return ports;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const servers = [];

/**
 * Boots the example from its own entrypoint. `detached` puts it in its own process group, because
 * the runner spawns a child of its own and killing only the parent strands the listening socket.
 */
async function startExample(name, port, env) {
  const child = spawn(TSX, ['src/server.ts'], {
    cwd: EXAMPLE,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Every variable the example reads is set here, so a developer's local `.env` -- which
    // `loadEnvFile` never lets override the environment -- cannot change any verdict. CI has none.
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: env.baseUrl,
      APPLICATIONS,
      APPLICATION_KEY: env.applicationKey,
      CALLBACK_ROUTE: env.callbackRoute,
      CALLBACK_SIGNED_PATH: env.callbackSignedPath,
      DENY_DESTINATION_PREFIX: env.denyDestinationPrefix ?? '',
    },
  });

  const server = { name, port, child, output: '' };
  servers.push(server);
  child.stdout.on('data', (chunk) => (server.output += String(chunk)));
  child.stderr.on('data', (chunk) => (server.output += String(chunk)));

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with ${String(child.exitCode)}:\n${server.output}`);
    }
    if (await canConnect(port)) return server;
    await delay(100);
  }
  throw new Error(`${name} never listened on ${String(port)}:\n${server.output}`);
}

function stop(server) {
  try {
    // The group, not the process: `tsx` runs the server in a child of its own.
    process.kill(-server.child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** stdout is a pipe, so a line written before the HTTP answer can still be in flight. */
async function waitForOutput(server, needle) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.output.includes(needle)) return true;
    await delay(100);
  }
  return false;
}

let api;
let ports;

/** The mobile app's own start: `public` auth, straight to the API, never through the example. */
async function startAs(key, destination) {
  const response = await fetch(`${api.url}/api/v1/verifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Application ${key}` },
    body: JSON.stringify({ data: { destination, delivery_method: 'sms' } }),
  });
  return (await response.json()).data;
}

/** A report through the example's proxy route, which signs it with `application` auth. */
async function reportVia(port, id, body) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/verifications/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const outcome = (verification) => [verification.status, verification.error_code];

beforeAll(async () => {
  const [allowPort, barePort, wrongPathPort] = await freePorts(3);
  ports = { allow: allowPort, bare: barePort, wrongPath: wrongPathPort };

  api = createMockApi({
    port: 0,
    code: CODE,
    applications: [
      {
        key: KEYS.allow,
        secret: SECRETS.allow,
        minimumScheme: 'public',
        callbackUrl: `http://127.0.0.1:${String(allowPort)}${CALLBACK_ROUTE}`,
      },
      // Registered at a bare origin: the API signs the EMPTY STRING, not '/'.
      {
        key: KEYS.bare,
        secret: SECRETS.bare,
        minimumScheme: 'public',
        callbackUrl: `http://127.0.0.1:${String(barePort)}`,
      },
      {
        key: KEYS.wrongPath,
        secret: SECRETS.wrongPath,
        minimumScheme: 'public',
        callbackUrl: `http://127.0.0.1:${String(wrongPathPort)}${CALLBACK_ROUTE}`,
      },
      // No callback URL at all: a `public` start has nothing to authorize it.
      {
        key: KEYS.noCallback,
        secret: SECRETS.noCallback,
        minimumScheme: 'public',
        callbackUrl: null,
      },
    ],
  });
  await api.listen();

  await Promise.all([
    startExample('allow', allowPort, {
      baseUrl: api.url,
      applicationKey: KEYS.allow,
      callbackRoute: CALLBACK_ROUTE,
      callbackSignedPath: CALLBACK_ROUTE,
      denyDestinationPrefix: DENY_PREFIX,
    }),
    startExample('bare', barePort, {
      baseUrl: api.url,
      applicationKey: KEYS.bare,
      callbackRoute: '/',
      callbackSignedPath: '',
    }),
    startExample('wrong-path', wrongPathPort, {
      baseUrl: api.url,
      applicationKey: KEYS.wrongPath,
      callbackRoute: CALLBACK_ROUTE,
      callbackSignedPath: '/not-the-registered-path',
    }),
  ]);
});

afterAll(async () => {
  // Unconditional: a failed assertion above must not strand a listening process on the runner.
  for (const server of servers) stop(server);
  servers.length = 0;
  if (api !== undefined) await api.close();
});

describe('examples/node-server against examples/mock-api, over real sockets', () => {
  it('allows a start and carries the report through to verified', async () => {
    const started = await startAs(KEYS.allow, '+12025550143');
    expect(outcome(started)).toEqual(['pending', null]);

    const wrong = await reportVia(ports.allow, started.id, {
      delivery_method: 'sms',
      value: '000000',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0].code).toBe('code_invalid');

    const right = await reportVia(ports.allow, started.id, {
      delivery_method: 'sms',
      value: CODE,
    });
    expect(right.status).toBe(200);
    expect([right.body.status, right.body.error_code]).toEqual(['verified', null]);
  });

  // `denied_by_callback` is the assertion, not `denied`: the other denial slug renders the same
  // and means the endpoint failed to answer at all, which is the opposite of a working gate.
  it('denies the destinations its rule rejects, and says the gate is what denied them', async () => {
    const verification = await startAs(KEYS.allow, `+${DENY_PREFIX}5550100`);

    expect(outcome(verification)).toEqual(['denied', 'denied_by_callback']);
  });

  // Nothing is asked and nothing is wired: the application has no callback URL, so the start is
  // refused for a setup reason rather than by a decision.
  it('surfaces an application with no callback URL as its own setup slug', async () => {
    const verification = await startAs(KEYS.noCallback, '+12025550144');

    expect(outcome(verification)).toEqual(['denied', 'denied_missing_callback_url']);
  });

  // A registered `https://example.com` is signed against '', and an endpoint that assumes '/'
  // denies every verification with valid signatures on both sides. Configured through the
  // example's own environment, which is where that value is easiest to get wrong.
  it('accepts a bare-origin registration configured with the empty signed path', async () => {
    const bare = servers.find((server) => server.name === 'bare');

    const verification = await startAs(KEYS.bare, '+12025550145');

    expect(outcome(verification)).toEqual(['pending', null]);
    expect(bare.output).not.toContain('callback rejected');
  });

  // The negative control, and the production failure this whole design exists to prevent. The
  // endpoint is told a registered path the API never signed. The rejection line is asserted too:
  // an unmounted route would reach the same slug without the gate having judged anything.
  it('denies when the configured signed path is not the registered one', async () => {
    const control = servers.find((server) => server.name === 'wrong-path');

    const verification = await startAs(KEYS.wrongPath, '+12025550146');

    expect(outcome(verification)).toEqual(['denied', 'denied_invalid_callback_response']);
    expect(await waitForOutput(control, 'callback rejected: signature_mismatch')).toBe(true);
  });
});
