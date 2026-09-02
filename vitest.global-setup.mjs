import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Built once, here, before any test file runs. Two oracles pack the real tarballs and so need
// today's output rather than whatever was lying around -- but building inside their own `beforeAll`
// deleted and rewrote `dist` while other files were concurrently importing `@didww/verification-core`,
// which failed them with "Failed to resolve entry for package" perhaps one run in three.
export default function setup() {
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
}
