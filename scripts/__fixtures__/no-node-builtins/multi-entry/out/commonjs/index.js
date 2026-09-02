import { createHash } from 'node:crypto';
import { encode } from '@didww/verification-core';

export const useVerification = () => encode(createHash('md5'));
