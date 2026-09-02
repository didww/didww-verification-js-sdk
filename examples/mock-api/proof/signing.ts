// Proof scaffolding. A deliberate second implementation of the request signature, written from
// contract/wire-contract.json alone and importing nothing from ../src: a proof that signs with the
// code under test only demonstrates that the function is deterministic.

import { createHash, createHmac } from 'node:crypto';

export interface SignatureInput {
  method: string;
  contentType?: string | undefined;
  body?: string | undefined;
  timestamp: string;
  path: string;
}

export function contentMd5(body: string | undefined): string {
  if (body === undefined || body.trim() === '') return '';
  return createHash('md5').update(Buffer.from(body, 'utf8')).digest('base64');
}

export function sign(secret: string, input: SignatureInput): string {
  const key = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const lines = [
    input.method,
    contentMd5(input.body),
    input.contentType ?? '',
    `x-timestamp:${input.timestamp}`,
    input.path,
  ];
  return createHmac('sha256', key).update(lines.join('\n'), 'utf8').digest('base64');
}

export function epochSeconds(offset = 0): string {
  return String(Math.floor(Date.now() / 1000) + offset);
}
