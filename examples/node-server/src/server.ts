import { VerificationClient, isApiError, type Verification } from '@didww/verification-core';
import { applicationAuth } from '@didww/verification-node';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { callbackHandler } from './callbacks.ts';
import { readConfig } from './config.ts';
import { report } from './report.ts';

interface IdParams {
  id: string;
}

const config = readConfig();

// Signed `application` auth lives here and nowhere else: the secret never leaves this process,
// which is the reason a mobile app proxies its calls through a backend at all.
const client = new VerificationClient({
  baseUrl: config.baseUrl,
  auth: applicationAuth({ key: config.applicationKey, secret: config.applicationSecret }),
  logger: (line) => console.log(line),
});

const app = express();

// Parsers are per route, never global: the callback below must see the exact bytes that were
// signed, and a body re-serialized by `express.json()` is not them.
const json = express.json();

app.post(
  '/verifications',
  json,
  handle(async (req, res) => {
    const destination = stringField(req.body, 'destination');
    const deliveryMethod = stringField(req.body, 'delivery_method');
    if (destination === null || deliveryMethod === null) {
      res.status(400).json({ error: 'destination and delivery_method are required' });
      return;
    }
    res.status(201).json(view(await client.startVerification({ destination, deliveryMethod })));
  }),
);

app.put<IdParams>(
  '/verifications/:id',
  json,
  handle(async (req, res) => {
    const deliveryMethod = stringField(req.body, 'delivery_method');
    const value = stringField(req.body, 'value');
    if (deliveryMethod === null || value === null) {
      res.status(400).json({ error: 'delivery_method and value are required' });
      return;
    }
    res.json(view(await report(client, req.params.id, deliveryMethod, value)));
  }),
);

// Poll here after a start or report times out. Never re-send either: a report is not idempotent
// and only three attempts exist, and a second start supersedes the first and is billed again.
app.get<IdParams>(
  '/verifications/:id',
  handle(async (req, res) => {
    res.json(view(await client.getVerification(req.params.id)));
  }),
);

app.post(config.callbackRoute, express.raw({ type: '*/*' }), callbackHandler(config));

app.use(onError);

app.listen(config.port, () => {
  console.log(`node-server listening on http://127.0.0.1:${String(config.port)}`);
  console.log(`  api            ${config.baseUrl} as ${config.applicationKey}`);
  console.log(`  callback route POST ${config.callbackRoute}`);
  console.log(`  signed path    ${JSON.stringify(config.callbackSignedPath)}`);
  console.log(
    `  deny prefix    ${config.denyDestinationPrefix === '' ? '(none)' : config.denyDestinationPrefix}`,
  );
});

/** Forwards a rejection to the error handler on express 4 as well, which does not do it itself. */
function handle<P>(route: (req: Request<P>, res: Response) => Promise<void>): RequestHandler<P> {
  return (req, res, next) => {
    void route(req, res).catch(next);
  };
}

function stringField(body: unknown, name: string): string | null {
  const value = (body as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** What a mobile client needs. The fee is a quote for your books, so it stays on this side. */
function view(verification: Verification): Record<string, unknown> {
  return {
    id: verification.id,
    status: verification.status,
    delivery_method: verification.deliveryMethod,
    error_code: verification.errorCode,
    error_detail: verification.errorDetail,
    expires_at: verification.expiresAt,
    sms:
      verification.sms === null
        ? null
        : { interception_timeout: verification.sms.interceptionTimeoutSeconds },
  };
}

// The API's own status and error envelope travel through, so the client can switch on the code.
function onError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (isApiError(error)) {
    res.status(error.status).json({ errors: error.errors });
    return;
  }
  console.error(error);
  res.status(500).json({ errors: [{ code: 'internal_error', detail: null }] });
}
