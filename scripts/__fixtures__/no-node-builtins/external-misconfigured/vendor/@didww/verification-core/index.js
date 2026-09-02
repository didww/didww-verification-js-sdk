import { createHash } from 'node:crypto';

export const encode = (value) => createHash('sha256').update(value).digest('hex');
