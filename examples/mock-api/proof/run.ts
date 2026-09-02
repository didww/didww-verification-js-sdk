// Proof scaffolding. Boots the mock API and a stub callback receiver and exercises the wire
// behaviour over real HTTP. Every signature here is produced by ./signing.ts, which shares no code
// with the server; a request built by the server's own helper would prove nothing.

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { createMockApi } from '../src/server.ts';
import type { AuthScheme, MockApplication } from '../src/state.ts';
import {
  startCallbackReceiver,
  type ReceiverApplication,
  type ReceiverBehaviour,
} from './callback-receiver.ts';
import { epochSeconds, sign } from './signing.ts';

let checksRun = 0;
let checksFailed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checksRun += 1;
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  checksFailed += 1;
  console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

function equals(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    label,
    same,
    same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  body: unknown;
}

function request(
  origin: string,
  method: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const url = new URL(origin);
  return new Promise<Reply>((settle, reject) => {
    const outgoing = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method,
        path: target,
        headers: options.headers ?? {},
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          settle({ status: incoming.statusCode ?? 0, headers: incoming.headers, text, body });
        });
      },
    );
    outgoing.on('error', reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

interface Fixture {
  key: string;
  secret: string;
  minimumScheme: AuthScheme;
  /** Path registered under the receiver origin: '' is a bare origin, null is no callback URL. */
  path: string | null;
  behaviour: ReceiverBehaviour;
  /** Overrides the path the receiver verifies against, to model a mis-configured customer. */
  verifiesPath?: string | undefined;
}

const CALLBACK_PATH = '/callbacks/verification';

const FIXTURE_SPECS: Omit<Fixture, 'secret'>[] = [
  { key: 'key_signed_only', minimumScheme: 'application', path: CALLBACK_PATH, behaviour: 'allow' },
  { key: 'key_basic', minimumScheme: 'basic', path: null, behaviour: 'allow' },
  { key: 'key_basic_callback', minimumScheme: 'basic', path: CALLBACK_PATH, behaviour: 'allow' },
  { key: 'key_public_allow', minimumScheme: 'public', path: CALLBACK_PATH, behaviour: 'allow' },
  { key: 'key_public_bare', minimumScheme: 'public', path: '', behaviour: 'allow' },
  {
    key: 'key_public_bare_wrong',
    minimumScheme: 'public',
    path: '',
    behaviour: 'allow',
    verifiesPath: '/',
  },
  { key: 'key_public_deny', minimumScheme: 'public', path: CALLBACK_PATH, behaviour: 'deny' },
  {
    key: 'key_public_notjson',
    minimumScheme: 'public',
    path: CALLBACK_PATH,
    behaviour: 'not-json',
  },
  {
    key: 'key_public_noaction',
    minimumScheme: 'public',
    path: CALLBACK_PATH,
    behaviour: 'no-action',
  },
  {
    key: 'key_public_500',
    minimumScheme: 'public',
    path: CALLBACK_PATH,
    behaviour: 'server-error',
  },
  {
    key: 'key_public_oversize',
    minimumScheme: 'public',
    path: CALLBACK_PATH,
    behaviour: 'oversize',
  },
  { key: 'key_public_nocb', minimumScheme: 'public', path: null, behaviour: 'allow' },
];

const FIXTURES: Fixture[] = FIXTURE_SPECS.map((fixture, index) => ({
  ...fixture,
  secret: Buffer.from(`mock-api-proof-secret-${String(index)}`, 'utf8').toString('base64url'),
}));

const BY_KEY = new Map(FIXTURES.map((fixture) => [fixture.key, fixture]));

function fx(key: string): Fixture {
  const fixture = BY_KEY.get(key);
  if (fixture === undefined) throw new Error(`no fixture named ${key}`);
  return fixture;
}

function basicHeader(fixture: Fixture): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${fixture.key}:${fixture.secret}`, 'utf8').toString('base64')}`,
  };
}

function publicHeader(fixture: Fixture): Record<string, string> {
  return { authorization: `Application ${fixture.key}` };
}

function signedHeaders(
  fixture: Fixture,
  method: string,
  target: string,
  options: { body?: string; contentType?: string; timestampOffset?: number } = {},
): Record<string, string> {
  const timestamp = epochSeconds(options.timestampOffset ?? 0);
  const headers: Record<string, string> = {
    authorization: `Application ${fixture.key}:${sign(fixture.secret, {
      method,
      contentType: options.contentType,
      body: options.body,
      timestamp,
      path: target.split('?')[0] ?? '',
    })}`,
    'x-timestamp': timestamp,
  };
  if (options.contentType !== undefined) headers['content-type'] = options.contentType;
  return headers;
}

const JSON_TYPE = 'application/json';

function startBody(
  destination: string,
  deliveryMethod: string,
  block?: Record<string, unknown>,
): string {
  const data: Record<string, unknown> = { destination, delivery_method: deliveryMethod };
  if (block !== undefined) data[deliveryMethod] = block;
  return JSON.stringify({ data });
}

function reportBody(deliveryMethod: string, value: Record<string, unknown>): string {
  return JSON.stringify({ data: { delivery_method: deliveryMethod, ...value } });
}

function dataOf(reply: Reply): Record<string, unknown> {
  const body = reply.body;
  if (typeof body === 'object' && body !== null && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (typeof data === 'object' && data !== null) return data as Record<string, unknown>;
  }
  return {};
}

function errorCodesOf(reply: Reply): string[] {
  const body = reply.body;
  if (typeof body !== 'object' || body === null || !('errors' in body)) return [];
  const errors = (body as { errors: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'code' in entry
      ? String((entry as { code: unknown }).code)
      : '',
  );
}

function isUnauthorizedEnvelope(reply: Reply): boolean {
  const body = reply.body;
  if (typeof body !== 'object' || body === null) return false;
  if (Object.keys(body).length !== 1 || !('errors' in body)) return false;
  const errors = (body as { errors: unknown }).errors;
  if (!Array.isArray(errors) || errors.length !== 1) return false;
  const only: unknown = errors[0];
  if (typeof only !== 'object' || only === null) return false;
  const keys = Object.keys(only).sort();
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'detail') return false;
  const entry = only as { code: unknown; detail: unknown };
  return entry.code === 'unauthorized' && typeof entry.detail === 'string' && entry.detail !== '';
}

let numberSeed = 0;
function nextDestination(): string {
  numberSeed += 1;
  return `+3712${String(numberSeed).padStart(7, '0')}`;
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function main(): Promise<void> {
  const receiver = await startCallbackReceiver(
    FIXTURES.filter((fixture) => fixture.path !== null).map((fixture): ReceiverApplication => ({
      key: fixture.key,
      secret: fixture.secret,
      signedPath: fixture.verifiesPath ?? fixture.path ?? '',
      behaviour: fixture.behaviour,
    })),
  );

  const applications: MockApplication[] = FIXTURES.map((fixture) => ({
    key: fixture.key,
    secret: fixture.secret,
    minimumScheme: fixture.minimumScheme,
    callbackUrl: fixture.path === null ? null : `${receiver.origin}${fixture.path}`,
  }));

  const api = await createMockApi({ applications, callbackTimeoutMs: 2_000 }).listen();
  const base = api.url;
  const code = api.state.verificationCode;

  try {
    section('routes — all five, both report verbs');
    const routeNumber = nextDestination();
    const started = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(routeNumber, 'sms', { languages: ['de-DE'] }),
    });
    check('POST /api/v1/verifications -> 201', started.status === 201, started.text);
    const startedData = dataOf(started);
    equals('start reads pending', startedData.status, 'pending');
    equals('destination echoed as digits', startedData.destination, routeNumber.slice(1));
    equals('error_code null while pending', startedData.error_code, null);
    check('fee is a decimal string', typeof startedData.fee === 'string', String(startedData.fee));
    check('expires_at is an ISO timestamp', typeof startedData.expires_at === 'string');
    const sms = startedData.sms as Record<string, unknown> | undefined;
    check('sms block present for an sms verification', sms !== undefined);
    equals(
      'template matched the requested language',
      sms?.template,
      'Ihr Verifizierungscode lautet {{CODE}}',
    );
    equals('sms.language names the tag that matched', sms?.language, 'de-DE');
    check('interception_timeout is an integer', Number.isInteger(sms?.interception_timeout));
    check('app_hash key omitted when none was sent', sms !== undefined && !('app_hash' in sms));

    const id = String(startedData.id);
    const byId = `/api/v1/verifications/${encodeURIComponent(id)}`;
    const byNumber = `/api/v1/verifications/by_number/${routeNumber.slice(1)}`;

    const fetched = await request(base, 'GET', byId, { headers: basicHeader(fx('key_basic')) });
    check('GET /api/v1/verifications/{id} -> 200', fetched.status === 200, fetched.text);
    equals('same verification returned', dataOf(fetched).id, id);

    const fetchedByNumber = await request(base, 'GET', byNumber, {
      headers: basicHeader(fx('key_basic')),
    });
    check(
      'GET /api/v1/verifications/by_number/{number} -> 200',
      fetchedByNumber.status === 200,
      fetchedByNumber.text,
    );
    equals('by_number resolved the same row', dataOf(fetchedByNumber).id, id);

    const wrongCode = await request(base, 'PUT', byId, {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: reportBody('sms', { code: '000000' }),
    });
    check('PUT report -> 422', wrongCode.status === 422, wrongCode.text);
    equals('a wrong code is code_invalid', errorCodesOf(wrongCode), ['code_invalid']);

    const reported = await request(base, 'PATCH', byNumber, {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: reportBody('sms', { code }),
    });
    check('PATCH report by_number -> 200', reported.status === 200, reported.text);
    equals('the right code verifies', dataOf(reported).status, 'verified');

    section('auth — three schemes accepted, dispatched by the colon');
    const publicStart = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...publicHeader(fx('key_public_allow')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms'),
    });
    check('public: "Application <key>" -> 201', publicStart.status === 201, publicStart.text);
    equals('public start proceeds after an allow', dataOf(publicStart).status, 'pending');

    const basicStart = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'callout'),
    });
    check('basic: "Basic base64(key:secret)" -> 201', basicStart.status === 201, basicStart.text);
    check('callout returns no sms block', dataOf(basicStart).sms === undefined);

    section('languages — each channel resolves against its own catalogue');
    const calloutStart = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'callout', { languages: ['pt-BR', 'pt-PT'] }),
    });
    check('callout with languages -> 201', calloutStart.status === 201, calloutStart.text);
    equals(
      'callout.language names the first tag with a recording',
      (dataOf(calloutStart).callout as Record<string, unknown> | undefined)?.language,
      'pt-PT',
    );

    // fr-FR has a template and no recording, so the same list resolves differently per channel.
    const calloutFallback = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'callout', { languages: ['fr-FR'] }),
    });
    equals(
      'a tag with no recording falls back',
      (dataOf(calloutFallback).callout as Record<string, unknown> | undefined)?.language,
      'en-US',
    );

    const smsFrench = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms', { languages: ['fr-FR'] }),
    });
    equals(
      'the same tag resolves over sms',
      (dataOf(smsFrench).sms as Record<string, unknown> | undefined)?.language,
      'fr-FR',
    );

    const calloutWithHash = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'callout', { app_hash: 'not a hash' }),
    });
    check(
      'app_hash inside a callout block is dropped, not rejected',
      calloutWithHash.status === 201,
      calloutWithHash.text,
    );

    const calloutBadTag = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'callout', { languages: ['not a tag'] }),
    });
    equals('a malformed callout tag is languages_invalid', errorCodesOf(calloutBadTag), [
      'languages_invalid',
    ]);

    const signedTarget = '/api/v1/verifications';
    const signedBody = startBody(nextDestination(), 'sms');
    const signedStart = await request(base, 'POST', signedTarget, {
      headers: {
        ...signedHeaders(fx('key_signed_only'), 'POST', signedTarget, {
          body: signedBody,
          contentType: JSON_TYPE,
        }),
        'content-type': JSON_TYPE,
      },
      body: signedBody,
    });
    check(
      'application: "Application <key>:<signature>" -> 201',
      signedStart.status === 201,
      signedStart.text,
    );
    equals('a signed start is never sent to the callback', dataOf(signedStart).status, 'pending');

    section('auth — every failure is the same 401');
    const failures: [string, Reply][] = [
      [
        'unknown key (public)',
        await request(base, 'GET', byId, { headers: { authorization: 'Application no_such_key' } }),
      ],
      [
        'wrong secret (basic)',
        await request(base, 'GET', byId, {
          headers: {
            authorization: `Basic ${Buffer.from(`${fx('key_basic').key}:wrong`, 'utf8').toString('base64')}`,
          },
        }),
      ],
      [
        'bad signature (application)',
        await request(base, 'GET', byId, {
          headers: {
            ...signedHeaders(fx('key_signed_only'), 'GET', byId),
            authorization: `Application ${fx('key_signed_only').key}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
          },
        }),
      ],
      [
        'stale timestamp (application)',
        await request(base, 'GET', byId, {
          headers: signedHeaders(fx('key_signed_only'), 'GET', byId, { timestampOffset: -301 }),
        }),
      ],
      [
        'scheme below the application minimum (public)',
        await request(base, 'GET', byId, { headers: publicHeader(fx('key_signed_only')) }),
      ],
      [
        'scheme below the application minimum (basic)',
        await request(base, 'GET', byId, { headers: basicHeader(fx('key_signed_only')) }),
      ],
      ['no Authorization header at all', await request(base, 'GET', byId)],
    ];
    for (const [label, reply] of failures) {
      check(
        `401 unauthorized and nothing more: ${label}`,
        reply.status === 401 && isUnauthorizedEnvelope(reply),
        `${String(reply.status)} ${reply.text}`,
      );
    }

    section('signing — computed independently of the server');
    const signedId = String(dataOf(signedStart).id);
    const signedGetTarget = `/api/v1/verifications/${encodeURIComponent(signedId)}`;
    const signedGet = await request(base, 'GET', signedGetTarget, {
      headers: signedHeaders(fx('key_signed_only'), 'GET', signedGetTarget),
    });
    check(
      'a bodyless signed GET sending NO Content-Type header verifies -> 200',
      signedGet.status === 200,
      signedGet.text,
    );
    equals("and returns that application's own verification", dataOf(signedGet).id, signedId);

    const withContentType = await request(base, 'GET', signedGetTarget, {
      headers: {
        ...signedHeaders(fx('key_signed_only'), 'GET', signedGetTarget),
        'content-type': JSON_TYPE,
      },
    });
    check(
      'the same signature with a Content-Type header added is rejected',
      withContentType.status === 401 && isUnauthorizedEnvelope(withContentType),
      withContentType.text,
    );

    const encodedTarget = `/api/v1/verifications/${encodeURIComponent('a/b')}`;
    const encodedId = await request(base, 'GET', encodedTarget, {
      headers: signedHeaders(fx('key_signed_only'), 'GET', encodedTarget),
    });
    check(
      'a percent-encoded id signs the undecoded path: 404, not 401',
      encodedId.status === 404,
      encodedId.text,
    );

    section('callback — outcomes');
    const callbackCases: [string, string, string | null][] = [
      ['key_public_bare', 'pending', null],
      ['key_public_deny', 'denied', 'denied_by_callback'],
      ['key_public_notjson', 'denied', 'denied_invalid_callback_response'],
      ['key_public_noaction', 'denied', 'denied_invalid_callback_response'],
      ['key_public_500', 'denied', 'denied_invalid_callback_response'],
      ['key_public_oversize', 'denied', 'denied_invalid_callback_response'],
      ['key_public_bare_wrong', 'denied', 'denied_invalid_callback_response'],
    ];
    const callbackDestinations = new Map<string, string>();
    for (const [key, status, errorCode] of callbackCases) {
      const destination = nextDestination();
      callbackDestinations.set(key, destination);
      const reply = await request(base, 'POST', '/api/v1/verifications', {
        headers: { ...publicHeader(fx(key)), 'content-type': JSON_TYPE },
        body: startBody(destination, 'sms'),
      });
      check(`${key} -> 201`, reply.status === 201, reply.text);
      equals(`${key} status`, dataOf(reply).status, status);
      equals(`${key} error_code`, dataOf(reply).error_code, errorCode);
    }

    const bareCall = receiver.received.find((entry) => entry.key === 'key_public_bare');
    check(
      'the bare-origin callback was signed against the empty string',
      bareCall?.signatureValid === true,
    );
    equals('and it arrived at the origin root', bareCall?.target, '/');
    const bareBody = JSON.parse(bareCall?.body ?? '{}') as {
      event?: string;
      data?: Record<string, unknown>;
    };
    equals('the callback body is a verification_request', bareBody.event, 'verification_request');
    equals(
      'carrying id, destination and delivery_method',
      Object.keys(bareBody.data ?? {}).sort(),
      ['delivery_method', 'destination', 'id'],
    );
    equals(
      'with the destination as digits',
      bareBody.data?.destination,
      callbackDestinations.get('key_public_bare')?.slice(1),
    );
    const wrongCall = receiver.received.find((entry) => entry.key === 'key_public_bare_wrong');
    check(
      'a receiver verifying the received path instead of the registered one rejects it',
      wrongCall?.signatureValid === false,
    );

    section('callback — when it is not sent');
    const before = receiver.received.length;
    const noCallback = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...publicHeader(fx('key_public_nocb')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms'),
    });
    equals('public with no callback URL is denied', dataOf(noCallback).status, 'denied');
    equals(
      'with denied_missing_callback_url',
      dataOf(noCallback).error_code,
      'denied_missing_callback_url',
    );
    equals('and no outbound request was made', receiver.received.length, before);

    const basicNoCallback = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms'),
    });
    equals('basic with no callback URL proceeds', dataOf(basicNoCallback).status, 'pending');

    const signedOverCallbackBody = startBody(nextDestination(), 'sms');
    const signedOverCallback = await request(base, 'POST', signedTarget, {
      headers: {
        ...signedHeaders(fx('key_basic_callback'), 'POST', signedTarget, {
          body: signedOverCallbackBody,
          contentType: JSON_TYPE,
        }),
        'content-type': JSON_TYPE,
      },
      body: signedOverCallbackBody,
    });
    equals(
      'a signed start on an application with a callback proceeds',
      dataOf(signedOverCallback).status,
      'pending',
    );
    equals('and asked no callback', receiver.received.length, before);

    section('state — supersede, attempts, expiry');
    const supersededNumber = nextDestination();
    const first = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(supersededNumber, 'sms'),
    });
    const second = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(supersededNumber, 'sms'),
    });
    const firstId = String(dataOf(first).id);
    const superseded = await request(base, 'GET', `/api/v1/verifications/${firstId}`, {
      headers: basicHeader(fx('key_basic')),
    });
    equals('the superseded row reads failed', dataOf(superseded).status, 'failed');
    equals('with error_code superseded', dataOf(superseded).error_code, 'superseded');
    const newest = await request(
      base,
      'GET',
      `/api/v1/verifications/by_number/${supersededNumber.slice(1)}`,
      { headers: basicHeader(fx('key_basic')) },
    );
    equals('by_number resolves to the newest row', dataOf(newest).id, dataOf(second).id);

    const attemptsNumber = nextDestination();
    await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(attemptsNumber, 'sms'),
    });
    const attemptTarget = `/api/v1/verifications/by_number/${attemptsNumber.slice(1)}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const reply = await request(base, 'PUT', attemptTarget, {
        headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
        body: reportBody('sms', { code: '000000' }),
      });
      check(`report attempt ${String(attempt)} of 3 is a 422`, reply.status === 422, reply.text);
    }
    const exhausted = await request(base, 'PUT', attemptTarget, {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: reportBody('sms', { code }),
    });
    check('the fourth report answers 200, not a 4xx', exhausted.status === 200, exhausted.text);
    equals('with status failed', dataOf(exhausted).status, 'failed');
    equals('and error_code too_many_attempts', dataOf(exhausted).error_code, 'too_many_attempts');

    section('state — every modelled channel is reported with a code');
    const codeNumber = nextDestination();
    const codeStart = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(codeNumber, 'callout'),
    });
    check('a callout start returns no sms block', dataOf(codeStart).sms === undefined);
    const codeTarget = `/api/v1/verifications/${String(dataOf(codeStart).id)}`;
    const wrongField = await request(base, 'PUT', codeTarget, {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: reportBody('callout', { cli: '12025550143' }),
    });
    equals('a cli instead of a code is refused', errorCodesOf(wrongField), [
      'cli_value_present',
      'code_blank',
    ]);
    const codeVerified = await request(base, 'PUT', codeTarget, {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: reportBody('callout', { code }),
    });
    equals('the right code verifies', dataOf(codeVerified).status, 'verified');

    const unmodelled = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'carrier_pigeon'),
    });
    equals('a channel the SDK does not model is refused at start', errorCodesOf(unmodelled), [
      'delivery_method_inclusion',
    ]);

    section('validation');
    const noData = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: JSON.stringify({ nope: true }),
    });
    check('a body with no data object is a 400', noData.status === 400, noData.text);
    equals('with parameter_missing', errorCodesOf(noData), ['parameter_missing']);

    const emptyData = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: JSON.stringify({ data: {} }),
    });
    check('an empty data object is a 422', emptyData.status === 422, emptyData.text);
    equals('one error element per field', errorCodesOf(emptyData), [
      'destination_blank',
      'delivery_method_blank',
    ]);

    const dotted = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody('+371.12345678', 'sms'),
    });
    equals("a '.' is not a separator", errorCodesOf(dotted), ['destination_invalid']);

    const badHash = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms', { app_hash: 'too-short' }),
    });
    check('a malformed app hash fails the whole start', badHash.status === 422, badHash.text);
    equals('with app_hash_invalid', errorCodesOf(badHash), ['app_hash_invalid']);

    const goodHash = await request(base, 'POST', '/api/v1/verifications', {
      headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
      body: startBody(nextDestination(), 'sms', { app_hash: 'AbC12+/xyzQ' }),
    });
    equals(
      'an accepted app hash is echoed back',
      (dataOf(goodHash).sms as Record<string, unknown>).app_hash,
      'AbC12+/xyzQ',
    );

    section('state — expired is synthesised on read');
    const shortLived = await createMockApi({
      applications,
      verificationLifetimeSeconds: 0,
      callbackTimeoutMs: 2_000,
    }).listen();
    try {
      const expiring = await request(shortLived.url, 'POST', '/api/v1/verifications', {
        headers: { ...basicHeader(fx('key_basic')), 'content-type': JSON_TYPE },
        body: startBody(nextDestination(), 'sms'),
      });
      equals('created pending', dataOf(expiring).status, 'pending');
      await sleep(25);
      const expired = await request(
        shortLived.url,
        'GET',
        `/api/v1/verifications/${String(dataOf(expiring).id)}`,
        { headers: basicHeader(fx('key_basic')) },
      );
      equals('reads expired once past the deadline', dataOf(expired).status, 'expired');
      equals('with error_code expired', dataOf(expired).error_code, 'expired');
    } finally {
      await shortLived.close();
    }
  } finally {
    await api.close();
    await receiver.close();
  }

  console.log(
    `\n${String(checksRun)} checks, ${String(checksFailed)} failed, ${String(checksRun - checksFailed)} passed`,
  );
  if (checksFailed > 0) process.exitCode = 1;
}

await main();
