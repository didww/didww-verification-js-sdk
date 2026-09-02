// The published declarations of @didww/verification-node must name no express type: the package
// declares one dependency (core), so a consumer resolving `express` out of our .d.ts gets TS7016,
// or a silent `any` under skipLibCheck. Asserting that inside the workspace is vacuous -- the
// hoisted @types/express makes a bad .d.ts compile -- so the tarball is installed into a scratch
// project outside it and typechecked there with `skipLibCheck: false` and `types: []`.
//
// Two controls keep the check honest: a declaration that does name express must fail, and the same
// declaration must pass once express types are resolvable.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const PACKAGE = '@didww/verification-node';
const CORE = '@didww/verification-core';

// A module specifier that pulls in express types, however it is spelled. Matched against quoted
// specifiers only -- imports and triple-slash references alike -- because the public API is called
// `expressCallbackHandler`: a substring search would flag the correct declarations.
const EXPRESS_SPECIFIER = /^(?:@types\/)?express(?:-serve-static-core)?(?:\/|$)/;
const QUOTED_SPECIFIER = /['"]([^'"\n]+)['"]/g;

// Exercises every name the barrel exports; a name missing from it fails this file, not just tsc.
const CONSUMER_SOURCE = `
import {
  CallbackVerifier,
  Signer,
  applicationAuth,
  expressCallbackHandler,
  type CallbackDecision,
  type CallbackHandler,
  type CallbackPayload,
  type CallbackRejectionReason,
  type CallbackRequestLike,
  type CallbackResponseLike,
  type CallbackVerification,
  type CallbackVerifierOptions,
  type CallbackVerifyInput,
  type ExpressCallbackHandlerOptions,
  type ParsedAuthorization,
  type SecretSource,
  type SignInput,
} from '${PACKAGE}';

const input: SignInput = {
  method: 'POST',
  path: '/api/v1/verifications',
  contentType: 'application/json',
  body: '{}',
  timestamp: 1,
};
export const signature: string = new Signer('c2VjcmV0').sign(input);
export const auth = applicationAuth({ key: 'key', secret: 'c2VjcmV0' });

const secret: SecretSource = (key: string) => (key === 'key' ? 'c2VjcmV0' : null);
const verifierOptions: CallbackVerifierOptions = { secret, tolerance: 300 };
const verifier = new CallbackVerifier(verifierOptions);
export const parsed: ParsedAuthorization = CallbackVerifier.parseAuthorization('Application k:s');
export function verify(input: CallbackVerifyInput): Promise<CallbackVerification> {
  return verifier.verify(input);
}

const handlerOptions: ExpressCallbackHandlerOptions = {
  secret,
  path: '',
  decide: (payload: CallbackPayload, _req: CallbackRequestLike): CallbackDecision =>
    payload.data.deliveryMethod === 'sms' ? { action: 'allow' } : { action: 'deny' },
  onRejected: (_reason: CallbackRejectionReason) => {},
};
export const handler: CallbackHandler = expressCallbackHandler(handlerOptions);
export function respond(res: CallbackResponseLike): void {
  res.status(200).end();
}
`;

// `lib: DOM` because core's declarations use AbortSignal, which ES2022 alone does not have.
// `types: []` and `skipLibCheck: false` are the point of the fixture: with either relaxed, an
// express reference in the shipped declarations goes unseen.
const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022', 'DOM'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
  include: ['consumer.ts'],
};

const EXPRESS_TYPED_DECLARATION = `
import type { Request, Response, NextFunction } from 'express';
export declare function expressCallbackHandler(
  options: unknown,
): (req: Request, res: Response, next: NextFunction) => void;
`;

const CONTROL_CONSUMER_SOURCE = `
import { expressCallbackHandler } from '${PACKAGE}';
export const handler = expressCallbackHandler({});
`;

// Enough of express for the declaration above to resolve, standing in for the @types/express a
// workspace consumer would find hoisted above it.
const EXPRESS_STUB_DECLARATION = `
export interface Request {
  readonly method: string;
}
export interface Response {
  status(code: number): { end(): void };
}
export type NextFunction = (err?: unknown) => void;
`;

let scratch;
let consumer;
let control;
let controlWithExpress;
let packedFiles;

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  const useNode = npmCli && npmCli.endsWith('.js');
  return execFileSync(useNode ? process.execPath : 'npm', useNode ? [npmCli, ...args] : args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
}

function typecheck(project) {
  try {
    execFileSync(process.execPath, [TSC, '--noEmit', '-p', path.join(project, 'tsconfig.json')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: '' };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function declarationFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, entry))
    .filter((file) => /\.d\.[cm]?ts$/.test(file));
}

function expressSpecifiersIn(source) {
  return [...source.matchAll(QUOTED_SPECIFIER)]
    .map(([, specifier]) => specifier)
    .filter((specifier) => EXPRESS_SPECIFIER.test(specifier));
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'node-tarball-types-')));

  // The workspace is built once in vitest's globalSetup: building here raced with every other
  // file importing the built core.

  // Core is packed too because it is a real dependency, and an unpublished one -- installing the
  // node tarball alone would send npm to the registry for it.
  const packed = JSON.parse(
    npm(['pack', '--json', '--pack-destination', scratch, '-w', CORE, '-w', PACKAGE], ROOT),
  );
  const tarballs = Object.fromEntries(packed.map((p) => [p.name, path.join(scratch, p.filename)]));
  packedFiles = packed.find((p) => p.name === PACKAGE).files.map((file) => file.path);

  consumer = path.join(scratch, 'consumer');
  fs.mkdirSync(consumer);
  writeJson(path.join(consumer, 'package.json'), {
    name: 'node-tarball-types-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  });
  npm(
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarballs[CORE], tarballs[PACKAGE]],
    consumer,
  );
  writeJson(path.join(consumer, 'tsconfig.json'), CONSUMER_TSCONFIG);
  fs.writeFileSync(path.join(consumer, 'consumer.ts'), CONSUMER_SOURCE);

  control = path.join(scratch, 'control');
  fs.cpSync(consumer, control, { recursive: true });
  fs.writeFileSync(
    path.join(control, 'node_modules', PACKAGE, 'dist', 'index.d.ts'),
    EXPRESS_TYPED_DECLARATION,
  );
  fs.writeFileSync(path.join(control, 'consumer.ts'), CONTROL_CONSUMER_SOURCE);

  controlWithExpress = path.join(scratch, 'control-with-express');
  fs.cpSync(control, controlWithExpress, { recursive: true });
  const stub = path.join(controlWithExpress, 'node_modules', 'express');
  fs.mkdirSync(stub);
  writeJson(path.join(stub, 'package.json'), {
    name: 'express',
    version: '0.0.0',
    types: 'index.d.ts',
  });
  fs.writeFileSync(path.join(stub, 'index.d.ts'), EXPRESS_STUB_DECLARATION);
}, 170_000);

describe('the packed @didww/verification-node', () => {
  it('typechecks in a project that has only this package and core installed', () => {
    const { ok, output } = typecheck(consumer);
    expect(output).toBe('');
    expect(ok).toBe(true);
  });

  it('ships declarations that name no express module', () => {
    const offenders = [];
    for (const file of declarationFiles(path.join(consumer, 'node_modules', PACKAGE, 'dist'))) {
      for (const specifier of expressSpecifiersIn(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.basename(file)} imports "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships no test file', () => {
    const shipped = packedFiles.filter((file) =>
      /(^|\/)(src|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file),
    );
    expect(shipped).toEqual([]);
  });

  // Control 1: the check is not vacuous -- it fails on declarations that do name express.
  it('would fail on declarations that name express', () => {
    const { ok, output } = typecheck(control);
    expect(output).toContain("Cannot find module 'express'");
    expect(ok).toBe(false);
  });

  // Control 2: and it fails for the intended reason. The same declarations pass once express types
  // resolve, which is why this whole fixture lives outside the workspace and its hoisted
  // @types/express -- asserted in there, the check would pass on a broken package.
  it('would pass on those same declarations wherever express types resolve', () => {
    const { ok, output } = typecheck(controlWithExpress);
    expect(output).toBe('');
    expect(ok).toBe(true);
  });
});
