// Proof scaffolding. This is the CUSTOMER's side of the callback — the endpoint an application
// registers with the API — and it is not part of the mocked service. It lives here only so the
// proof can observe what the mock sends and answer each documented outcome on demand.

import { createServer, type Server } from 'node:http';

import { sign } from './signing.ts';

export type ReceiverBehaviour =
  'allow' | 'deny' | 'not-json' | 'no-action' | 'server-error' | 'oversize';

export interface ReceiverApplication {
  key: string;
  secret: string;
  /** The path the receiver expects the API to have signed: '' for a bare-origin registration. */
  signedPath: string;
  behaviour: ReceiverBehaviour;
}

export interface ReceivedCallback {
  key: string;
  method: string;
  target: string;
  contentType: string;
  timestamp: string;
  signatureValid: boolean;
  body: string;
}

export interface CallbackReceiver {
  readonly origin: string;
  readonly received: ReceivedCallback[];
  close(): Promise<void>;
}

const OVERSIZE_PADDING = 'x'.repeat(9000);

function answer(behaviour: ReceiverBehaviour): { status: number; type: string; body: string } {
  switch (behaviour) {
    case 'allow':
      return { status: 200, type: 'application/json', body: JSON.stringify({ action: 'allow' }) };
    case 'deny':
      return { status: 200, type: 'application/json', body: JSON.stringify({ action: 'deny' }) };
    case 'not-json':
      return { status: 200, type: 'text/plain', body: 'this is not json' };
    case 'no-action':
      return { status: 200, type: 'application/json', body: JSON.stringify({ ok: true }) };
    case 'server-error':
      return { status: 500, type: 'application/json', body: JSON.stringify({ action: 'allow' }) };
    case 'oversize':
      return {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ action: 'allow', padding: OVERSIZE_PADDING }),
      };
  }
}

export async function startCallbackReceiver(
  applications: readonly ReceiverApplication[],
): Promise<CallbackReceiver> {
  const byKey = new Map(applications.map((application) => [application.key, application]));
  const received: ReceivedCallback[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const authorization = request.headers.authorization ?? '';
      const separator = authorization.indexOf(':');
      const key = authorization.slice(
        'Application '.length,
        separator === -1 ? undefined : separator,
      );
      const presented = separator === -1 ? '' : authorization.slice(separator + 1);
      const timestamp = request.headers['x-timestamp'] ?? '';
      const contentType = request.headers['content-type'] ?? '';
      const application = byKey.get(key);

      const expected =
        application === undefined
          ? ''
          : sign(application.secret, {
              method: request.method ?? '',
              contentType,
              body,
              timestamp: typeof timestamp === 'string' ? timestamp : '',
              path: application.signedPath,
            });
      const signatureValid = application !== undefined && expected === presented;

      received.push({
        key,
        method: request.method ?? '',
        target: request.url ?? '',
        contentType,
        timestamp: typeof timestamp === 'string' ? timestamp : '',
        signatureValid,
        body,
      });

      if (application === undefined || !signatureValid) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const reply = answer(application.behaviour);
      response.writeHead(reply.status, { 'content-type': reply.type });
      response.end(reply.body);
    });
  });

  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('receiver did not listen');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: () =>
      new Promise<void>((settle, reject) => {
        server.close((error) => (error ? reject(error) : settle()));
      }),
  };
}
