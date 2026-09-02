import { createHash } from 'node:crypto';
import { encode } from '@didww/verification-core';

export const useVerification = () => encode(createHash('sha256').update('ok').digest('hex'));
