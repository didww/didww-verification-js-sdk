import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_HASH_PATTERN,
  CALLBACK_READ_LIMIT_BYTES,
  CALLBACK_RETRIES,
  CODE,
  DEFAULT_CALLBACK_BASE_URL,
  DESTINATION_PATTERN,
  GENERATED_CODE_LENGTH,
  LANGUAGE_TAG_PATTERN,
  MAX_REPORT_ATTEMPTS,
  METHOD,
  MockState,
  REPLAY_WINDOW_SECONDS,
  SCHEME_RANK,
  STATUS,
  VERIFICATION_LIFETIME_SECONDS,
  contract,
  defaultApplications,
  digitsOf,
  errorDetail,
  isDeliveryMethod,
  newVerificationId,
  normalizedDestination,
  LANGUAGE_CATALOGUES,
  renderVerification,
  resolveLanguage,
  resolveTemplate,
  viewOf,
  type AuthScheme,
  type MockApplication,
  type VerificationRow,
} from './state.ts';

// One request, one answer. The snapshot pins callback.request.retries at 0, so an unusable answer
// denies the verification rather than being tried again; a non-zero value needs new code, not a
// silently ignored constant.
if (CALLBACK_RETRIES !== 0) {
  throw new Error('mock-api implements callback.request.retries: 0 only');
}

const DEFAULT_CODE = '123456';
const DEFAULT_FEE = '0.0345';
const DEFAULT_CALLBACK_TIMEOUT_MS = 5_000;

if (DEFAULT_CODE.length !== GENERATED_CODE_LENGTH) {
  throw new Error(`the fixed code must be ${String(GENERATED_CODE_LENGTH)} characters`);
}

export interface MockApiOptions {
  port?: number;
  host?: string;
  applications?: readonly MockApplication[];
  /** Origin the default applications register their callback URLs under. */
  callbackBaseUrl?: string;
  code?: string;
  fee?: string;
  verificationLifetimeSeconds?: number;
  callbackTimeoutMs?: number;
  /** Log one line per request, body included. Off by default; headers are never logged. */
  logRequests?: boolean;
}

export interface MockApi {
  readonly server: Server;
  readonly state: MockState;
  /** Throws until `listen()` has resolved. */
  readonly port: number;
  readonly url: string;
  listen(): Promise<MockApi>;
  close(): Promise<void>;
}

interface Operation {
  name: string;
  methods: readonly string[];
  pattern: RegExp;
  params: readonly string[];
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  application: MockApplication;
  scheme: AuthScheme;
  params: Record<string, string>;
  body: Buffer;
  at: number;
}

type Handler = (context: RequestContext) => Promise<void> | void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compileOperations(): Operation[] {
  const operations: Operation[] = [];
  for (const [name, definition] of Object.entries(contract.paths)) {
    if (!isPlainObject(definition)) continue;
    const template = definition.path;
    const methods = definition.methods;
    if (typeof template !== 'string' || !Array.isArray(methods)) continue;
    const params: string[] = [];
    const source = template.replace(/\{(\w+)\}|[^{}]+/g, (segment, param: string | undefined) => {
      if (param === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      params.push(param);
      return '([^/]+)';
    });
    operations.push({
      name,
      methods: methods.map(String),
      pattern: new RegExp(`^${source}$`),
      params,
    });
  }
  return operations;
}

const OPERATIONS = compileOperations();

function pathOf(requestTarget: string): string {
  const queryStart = requestTarget.indexOf('?');
  return queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
}

// A '.' in the last path segment is read as a format suffix and never reaches the number, which is
// why '+371.12345678' addresses '371' instead of being normalised.
function withoutFormatSuffix(segment: string): string {
  const dot = segment.indexOf('.');
  return dot === -1 ? segment : segment.slice(0, dot);
}

function decodeUrlSafeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface SignatureParts {
  method: string;
  contentMd5: string;
  contentType: string;
  timestamp: string;
  path: string;
}

export function stringToSign(parts: SignatureParts): string {
  return [
    parts.method,
    parts.contentMd5,
    parts.contentType,
    `x-timestamp:${parts.timestamp}`,
    parts.path,
  ].join('\n');
}

export function signature(secret: string, parts: SignatureParts): string {
  return createHmac('sha256', decodeUrlSafeBase64(secret))
    .update(stringToSign(parts), 'utf8')
    .digest('base64');
}

/** Empty when the body is absent, empty, or whitespace only — never the MD5 of the whitespace. */
export function contentMd5Of(body: Buffer): string {
  if (body.length === 0 || body.toString('utf8').trim() === '') return '';
  return createHash('md5').update(body).digest('base64');
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface Credentials {
  key: string;
  scheme: AuthScheme;
  secret?: string;
  signature?: string;
}

// Dispatch is by the colon: 'Application <key>:<signature>' is the signed scheme and
// 'Application <key>' is the public one. Reading it any other way silently accepts a key as a
// signature, or a signed request as an unsigned one.
export function parseAuthorization(header: string | undefined): Credentials | null {
  if (header === undefined) return null;
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    return {
      scheme: 'basic',
      key: decoded.slice(0, separator),
      secret: decoded.slice(separator + 1),
    };
  }
  if (header.startsWith('Application ')) {
    const token = header.slice('Application '.length);
    const separator = token.indexOf(':');
    if (separator === -1) {
      return token === '' ? null : { scheme: 'public', key: token };
    }
    if (separator === 0 || separator === token.length - 1) return null;
    return {
      scheme: 'application',
      key: token.slice(0, separator),
      signature: token.slice(separator + 1),
    };
  }
  return null;
}

function verifiesSignature(
  application: MockApplication,
  credentials: Credentials,
  request: IncomingMessage,
  body: Buffer,
): boolean {
  const timestamp = request.headers['x-timestamp'];
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > REPLAY_WINDOW_SECONDS) return false;

  const expected = signature(application.secret, {
    method: request.method ?? '',
    contentMd5: contentMd5Of(body),
    // The exact header value received, and empty when the request carried none: a transport that
    // defaults a content type on a bodyless request 401s every signed GET.
    contentType: request.headers['content-type'] ?? '',
    timestamp,
    path: pathOf(request.url ?? ''),
  });
  return constantTimeEquals(expected, credentials.signature ?? '');
}

function authenticate(
  state: MockState,
  request: IncomingMessage,
  body: Buffer,
): { application: MockApplication; scheme: AuthScheme } | null {
  const credentials = parseAuthorization(request.headers.authorization);
  if (credentials === null) return null;

  const application = state.application(credentials.key);
  if (application === undefined) return null;

  if (credentials.scheme === 'basic') {
    if (!constantTimeEquals(application.secret, credentials.secret ?? '')) return null;
  }
  if (credentials.scheme === 'application') {
    if (!verifiesSignature(application, credentials, request, body)) return null;
  }
  if (SCHEME_RANK[credentials.scheme] < SCHEME_RANK[application.minimumScheme]) return null;

  return { application, scheme: credentials.scheme };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendErrors(response: ServerResponse, status: number, codes: readonly string[]): void {
  sendJson(response, status, {
    errors: codes.map((code) => ({ code, detail: errorDetail(code) })),
  });
}

function sendVerification(
  response: ServerResponse,
  status: number,
  row: VerificationRow,
  at: number,
): void {
  sendJson(response, status, { data: renderVerification(row, at) });
}

function dataOf(body: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return isPlainObject(parsed.data) ? parsed.data : null;
}

function blank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

interface StartRequest {
  destination: string;
  deliveryMethod: string;
  template: string | null;
  language: string | null;
  appHash: string | null;
}

function readStartRequest(data: Record<string, unknown>): StartRequest | string[] {
  const errors: string[] = [];

  const destination = data.destination;
  if (blank(destination)) errors.push(CODE.destinationBlank);
  else if (
    typeof destination !== 'string' ||
    !DESTINATION_PATTERN.test(normalizedDestination(destination))
  ) {
    errors.push(CODE.destinationInvalid);
  }

  const deliveryMethod = data.delivery_method;
  if (blank(deliveryMethod)) errors.push(CODE.deliveryMethodBlank);
  else if (typeof deliveryMethod !== 'string' || !isDeliveryMethod(deliveryMethod)) {
    errors.push(CODE.deliveryMethodInclusion);
  }

  // Only the block named after the delivery method is read, and only for a channel that announces
  // a code at all -- a channel with no block must not pick up another channel's.
  const channel = typeof deliveryMethod === 'string' ? deliveryMethod : '';
  const catalogue = LANGUAGE_CATALOGUES.get(channel);
  const block = catalogue === undefined ? undefined : data[channel];
  const options: Record<string, unknown> = isPlainObject(block) ? block : {};

  let requested: string[] = [];
  const languages = options.languages;
  if (languages !== undefined) {
    const tags = Array.isArray(languages) ? languages : null;
    if (
      tags === null ||
      tags.some((tag) => typeof tag !== 'string' || !LANGUAGE_TAG_PATTERN.test(tag))
    ) {
      errors.push(CODE.languagesInvalid);
    } else {
      requested = tags as string[];
    }
  }
  const language = catalogue === undefined ? null : resolveLanguage(requested, catalogue);

  // app_hash is permitted inside the sms block only; elsewhere the key is dropped, not rejected.
  let appHash: string | null = null;
  const submittedHash = deliveryMethod === METHOD.sms ? options.app_hash : undefined;
  if (submittedHash !== undefined) {
    if (typeof submittedHash !== 'string' || !APP_HASH_PATTERN.test(submittedHash)) {
      errors.push(CODE.appHashInvalid);
    } else {
      appHash = submittedHash;
    }
  }

  if (errors.length > 0) return errors;
  return {
    destination: digitsOf(destination as string),
    deliveryMethod: deliveryMethod as string,
    template: deliveryMethod === METHOD.sms && language !== null ? resolveTemplate(language) : null,
    language,
    appHash,
  };
}

/** The path component of the REGISTERED URL, query excluded — '' when it carries no path. */
export function registeredCallbackPath(rawUrl: string): string {
  const afterScheme = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const authorityEnd = afterScheme.search(/[/?#]/);
  if (authorityEnd === -1) return '';
  const rest = afterScheme.slice(authorityEnd);
  if (!rest.startsWith('/')) return '';
  const end = rest.search(/[?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

type CallbackOutcome = 'allow' | 'deny' | 'invalid';

async function readCapped(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function askCallback(
  application: MockApplication,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CallbackOutcome> {
  const url = application.callbackUrl;
  if (url === null) return 'invalid';

  const body = JSON.stringify({ event: 'verification_request', data: payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = signature(application.secret, {
    method: 'POST',
    contentMd5: contentMd5Of(Buffer.from(body, 'utf8')),
    contentType: 'application/json',
    timestamp,
    path: registeredCallbackPath(url),
  });

  let response: Response;
  let text: string | null;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Application ${application.key}:${signed}`,
        'x-timestamp': timestamp,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readCapped(response, CALLBACK_READ_LIMIT_BYTES);
  } catch {
    return 'invalid';
  }

  if (text === null) return 'invalid';
  if (response.status < 200 || response.status > 299) return 'invalid';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  if (!isPlainObject(parsed)) return 'invalid';
  if (parsed.action === 'allow') return 'allow';
  if (parsed.action === 'deny') return 'deny';
  return 'invalid';
}

interface StartDecision {
  status: string;
  errorCode: string | null;
}

async function decideStart(
  application: MockApplication,
  scheme: AuthScheme,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<StartDecision> {
  // A signed start is already trusted, so the callback is never asked.
  if (scheme === 'application') return { status: STATUS.pending, errorCode: null };
  if (application.callbackUrl === null) {
    return scheme === 'public'
      ? { status: STATUS.denied, errorCode: CODE.deniedMissingCallbackUrl }
      : { status: STATUS.pending, errorCode: null };
  }
  switch (await askCallback(application, payload, timeoutMs)) {
    case 'allow':
      return { status: STATUS.pending, errorCode: null };
    case 'deny':
      return { status: STATUS.denied, errorCode: CODE.deniedByCallback };
    default:
      return { status: STATUS.denied, errorCode: CODE.deniedInvalidCallbackResponse };
  }
}

function readReportRequest(data: Record<string, unknown>, row: VerificationRow): string[] {
  const deliveryMethod = data.delivery_method;
  if (blank(deliveryMethod)) return [CODE.deliveryMethodBlank];
  if (typeof deliveryMethod !== 'string' || !isDeliveryMethod(deliveryMethod)) {
    return [CODE.deliveryMethodInclusion];
  }
  if (deliveryMethod !== row.deliveryMethod) return [CODE.deliveryMethodInvalid];

  const errors: string[] = [];
  if (!blank(data.cli)) errors.push(CODE.cliValuePresent);
  if (blank(data.code)) errors.push(CODE.codeBlank);
  return errors;
}

function handleReport(context: RequestContext, row: VerificationRow): void {
  const { response, at } = context;
  const data = dataOf(context.body);
  if (data === null) {
    sendErrors(response, 400, [CODE.parameterMissing]);
    return;
  }

  const errors = readReportRequest(data, row);
  if (errors.length > 0) {
    sendErrors(response, 422, errors);
    return;
  }

  const view = viewOf(row, at);
  if (view.status === STATUS.verified) {
    sendErrors(response, 422, [CODE.alreadyVerified]);
    return;
  }
  if (view.status !== STATUS.pending) {
    sendErrors(response, 422, [CODE.notReadyToReport]);
    return;
  }

  // Exhausting the attempts answers 200 with a failed verification, not a 4xx: whether another
  // attempt is allowed is the server's decision, and the client learns it from the status.
  if (row.attempts >= MAX_REPORT_ATTEMPTS) {
    row.status = STATUS.failed;
    row.errorCode = CODE.tooManyAttempts;
    sendVerification(response, 200, row, at);
    return;
  }

  if (data.code !== row.expectedValue) {
    row.attempts += 1;
    sendErrors(response, 422, [CODE.codeInvalid]);
    return;
  }

  row.status = STATUS.verified;
  row.errorCode = null;
  sendVerification(response, 200, row, at);
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const callbackBaseUrl = options.callbackBaseUrl ?? DEFAULT_CALLBACK_BASE_URL;
  const state = new MockState(options.applications ?? defaultApplications({ callbackBaseUrl }), {
    code: options.code ?? DEFAULT_CODE,
    fee: options.fee ?? DEFAULT_FEE,
    lifetimeSeconds: options.verificationLifetimeSeconds ?? VERIFICATION_LIFETIME_SECONDS,
  });
  const callbackTimeoutMs = options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const host = options.host ?? '127.0.0.1';

  const startVerification: Handler = async (context) => {
    const data = dataOf(context.body);
    if (data === null) {
      sendErrors(context.response, 400, [CODE.parameterMissing]);
      return;
    }
    const parsed = readStartRequest(data);
    if (Array.isArray(parsed)) {
      sendErrors(context.response, 422, parsed);
      return;
    }

    const id = newVerificationId();
    const decision = await decideStart(
      context.application,
      context.scheme,
      { id, destination: parsed.destination, delivery_method: parsed.deliveryMethod },
      callbackTimeoutMs,
    );

    state.supersede(context.application.key, parsed.destination);
    const row = state.create(
      {
        applicationKey: context.application.key,
        id,
        destination: parsed.destination,
        deliveryMethod: parsed.deliveryMethod,
        status: decision.status,
        errorCode: decision.errorCode,
        template: parsed.template,
        language: parsed.language,
        appHash: parsed.appHash,
      },
      context.at,
    );
    sendVerification(context.response, 201, row, context.at);
  };

  const rowById = (context: RequestContext): VerificationRow | undefined =>
    state.findById(context.application.key, decodeURIComponent(context.params.id ?? ''));

  const rowByNumber = (context: RequestContext): VerificationRow | undefined =>
    state.newestByNumber(
      context.application.key,
      digitsOf(withoutFormatSuffix(decodeURIComponent(context.params.number ?? ''))),
    );

  const show =
    (find: (context: RequestContext) => VerificationRow | undefined): Handler =>
    (context) => {
      const row = find(context);
      if (row === undefined) {
        sendErrors(context.response, 404, [CODE.notFound]);
        return;
      }
      sendVerification(context.response, 200, row, context.at);
    };

  const report =
    (find: (context: RequestContext) => VerificationRow | undefined): Handler =>
    (context) => {
      const row = find(context);
      if (row === undefined) {
        sendErrors(context.response, 404, [CODE.notFound]);
        return;
      }
      handleReport(context, row);
    };

  const handlers: Record<string, Handler> = {
    startVerification,
    getVerification: show(rowById),
    reportVerification: report(rowById),
    getVerificationByNumber: show(rowByNumber),
    reportVerificationByNumber: report(rowByNumber),
  };

  for (const operation of OPERATIONS) {
    if (handlers[operation.name] === undefined) {
      throw new Error(`contract/wire-contract.json declares '${operation.name}' with no handler`);
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    const path = pathOf(request.url ?? '');

    if (options.logRequests === true) {
      console.log(
        `${request.method ?? ''} ${request.url ?? ''} ${body.length === 0 ? '(no body)' : JSON.stringify(body.toString('utf8'))}`,
      );
    }

    for (const operation of OPERATIONS) {
      const match = operation.pattern.exec(path);
      if (match === null || !operation.methods.includes(request.method ?? '')) continue;

      const identified = authenticate(state, request, body);
      // Unknown key, wrong secret, bad signature, stale timestamp, too weak a scheme: one answer
      // for all of them, or the endpoint becomes an oracle for which keys exist.
      if (identified === null) {
        sendErrors(response, 401, [CODE.unauthorized]);
        return;
      }

      const params: Record<string, string> = {};
      operation.params.forEach((name, index) => {
        params[name] = match[index + 1] ?? '';
      });

      await handlers[operation.name]?.({
        request,
        response,
        application: identified.application,
        scheme: identified.scheme,
        params,
        body,
        at: Date.now(),
      });
      return;
    }

    sendErrors(response, 404, [CODE.notFound]);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendErrors(response, 500, [CODE.internalError]);
      else response.end();
    });
  });

  const api: MockApi = {
    server,
    state,
    get port() {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the mock API is not listening');
      }
      return address.port;
    },
    get url() {
      return `http://${host}:${String(api.port)}`;
    },
    listen: () =>
      new Promise<MockApi>((settle, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => {
          server.removeListener('error', reject);
          settle(api);
        });
      }),
    close: () =>
      new Promise<void>((settle, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else settle();
        });
      }),
  };
  return api;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const api = createMockApi({
    port: Number(process.env.PORT ?? '4000'),
    callbackBaseUrl: process.env.CALLBACK_BASE_URL ?? DEFAULT_CALLBACK_BASE_URL,
    logRequests: process.env.LOG_REQUESTS === '1',
  });
  await api.listen();
  console.log(`mock verification API listening on ${api.url}`);
  for (const application of api.state.applications.values()) {
    console.log(
      `  ${application.key}  scheme: ${application.minimumScheme}  secret: ${application.secret}  callback: ${application.callbackUrl ?? '(none)'}`,
    );
  }
  console.log(`  fixed code: ${api.state.verificationCode}`);
}
