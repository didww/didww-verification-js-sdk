// Negative controls for the publish-metadata gate. The checking logic is a pure
// function over parsed manifests, so each control is one field changed on an
// otherwise-valid input rather than a fixture repository.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { caretAdmits, checkMetadata } from './check-package-metadata.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-package-metadata.mjs');
const CORE = '@didww/verification-core';
const LICENSE = 'MIT License\n\nCopyright (c) 2026 Example Holder\n';

function basePackages() {
  return [
    {
      id: 'packages/verification-core',
      manifest: {
        repository: {
          type: 'git',
          url: 'git+https://example.com/x.git',
          directory: 'packages/verification-core',
        },
        name: CORE,
        version: '0.1.0',
        engines: { node: '>=22' },
        publishConfig: { access: 'public' },
        files: ['dist'],
      },
      license: LICENSE,
      entries: ['package.json', 'LICENSE', 'dist', 'src'],
    },
    {
      id: 'packages/verification-node',
      manifest: {
        repository: {
          type: 'git',
          url: 'git+https://example.com/x.git',
          directory: 'packages/verification-node',
        },
        name: '@didww/verification-node',
        version: '0.1.0',
        engines: { node: '>=22' },
        publishConfig: { access: 'public' },
        files: ['dist'],
        dependencies: { [CORE]: '^0.1.0' },
      },
      license: LICENSE,
      entries: ['package.json', 'LICENSE', 'dist', 'src'],
    },
    {
      id: 'packages/verification-react-native',
      manifest: {
        repository: {
          type: 'git',
          url: 'git+https://example.com/x.git',
          directory: 'packages/verification-react-native',
        },
        name: '@didww/verification-react-native',
        version: '0.1.0',
        engines: { node: '^22.13.0 || ^24.3.0 || >= 25.0.0' },
        publishConfig: { access: 'public' },
        files: ['lib', 'android/build.gradle', 'android/src/main', 'expo-module.config.json'],
        dependencies: { [CORE]: '^0.1.0' },
      },
      license: LICENSE,
      entries: ['package.json', 'LICENSE', 'lib', 'android', 'src'],
    },
  ];
}

// Returns every failure message, flattened across the named checks.
function run(mutate = () => {}) {
  const packages = basePackages();
  mutate({
    packages,
    find: (name) => packages.find((pkg) => pkg.manifest.name.endsWith(name)),
  });
  return checkMetadata({ rootLicense: LICENSE, packages }).flatMap((result) => result.failures);
}

function runGuard(args) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [GUARD, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('caretAdmits', () => {
  it('treats the minor as the breaking position below 1.0.0', () => {
    expect(caretAdmits([0, 1, 0], [0, 1, 0])).toBe(true);
    expect(caretAdmits([0, 1, 0], [0, 1, 99])).toBe(true);
    expect(caretAdmits([0, 1, 0], [0, 2, 0])).toBe(false);
    expect(caretAdmits([0, 1, 2], [0, 1, 1])).toBe(false);
  });

  it('pins only the patch when the minor is also zero', () => {
    expect(caretAdmits([0, 0, 3], [0, 0, 3])).toBe(true);
    expect(caretAdmits([0, 0, 3], [0, 0, 4])).toBe(false);
  });

  it('treats the major as the breaking position from 1.0.0 up', () => {
    expect(caretAdmits([1, 2, 0], [1, 9, 9])).toBe(true);
    expect(caretAdmits([1, 2, 0], [2, 0, 0])).toBe(false);
    expect(caretAdmits([1, 2, 0], [1, 1, 9])).toBe(false);
  });
});

describe('check-package-metadata', () => {
  it('passes on manifests that are all correct', () => {
    expect(run()).toEqual([]);
  });

  it('rejects a pinned dependency on core', () => {
    const failures = run(({ find }) => {
      find('verification-node').manifest.dependencies[CORE] = '0.1.0';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@didww/verification-node');
    expect(failures[0]).toContain('which is a pin, not a caret range');
  });

  it('rejects a caret range that does not admit the current core version', () => {
    const failures = run(({ find }) => {
      find(CORE).manifest.version = '0.2.0';
    });
    // Both dependents still say ^0.1.0, and 0.2.0 is outside every one of them.
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toContain('"^0.1.0" covers >=0.1.0 <0.2.0');
      expect(failure).toContain(`does not admit ${CORE}@0.2.0`);
      expect(failure).toContain('second copy of core');
    }
  });

  it('rejects a missing publishConfig.access', () => {
    const failures = run(({ find }) => {
      delete find('verification-node').manifest.publishConfig;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('publishConfig.access is undefined');
    expect(failures[0]).toContain('defaults to restricted');
  });

  it('rejects engines.node at 20', () => {
    const failures = run(({ find }) => {
      find(CORE).manifest.engines.node = '>=20';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('engines.node is ">=20"');
    expect(failures[0]).toContain('Expected a `>=22` range');
  });

  it('rejects a caret engines.node, which would exclude later Node majors', () => {
    const failures = run(({ find }) => {
      find(CORE).manifest.engines.node = '^22';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('engines.node is "^22"');
  });

  // The floor the other two packages take is the value this one must not have: it
  // advertises Node 22.0-22.12 and 23.x, which react-native rejects.
  it('rejects the plain floor on react-native', () => {
    const failures = run(({ find }) => {
      find('verification-react-native').manifest.engines.node = '>=22';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('engines.node is ">=22", expected');
    expect(failures[0]).toContain('^22.13.0 || ^24.3.0 || >= 25.0.0');
  });

  // Exactness is the point: a union that merely looks plausible is still a guess.
  it('rejects a react-native union that is not react-native’s own list', () => {
    const failures = run(({ find }) => {
      find('verification-react-native').manifest.engines.node = '^22.13.0 || >= 24.0.0';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Re-read react-native');
  });

  it('rejects a package with no declared engines expectation', () => {
    const failures = run(({ packages }) => {
      packages[0].manifest.name = '@didww/verification-something-new';
    });
    expect(failures.some((f) => f.includes('no engines.node expectation is declared'))).toBe(true);
  });

  // A `files` entry overrides .gitignore for its whole subtree, so listing `android` ships
  // every untracked local directory under it — build output, local.properties, tool scratch —
  // however many negations follow. Reverting to it must fail.
  it('rejects a react-native files list reverting to the whole android directory', () => {
    const failures = run(({ find }) => {
      find('verification-react-native').manifest.files = [
        'lib',
        'android',
        'expo-module.config.json',
        '!android/build',
        '!android/src/test',
        '!android/src/androidTest',
      ];
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"files" ships [android, expo-module.config.json, lib]');
    expect(failures[0]).toContain(
      'expected exactly [android/build.gradle, android/src/main, expo-module.config.json, lib]',
    );
  });

  it('rejects an extra positive entry in the files allowlist', () => {
    const failures = run(({ find }) => {
      find(CORE).manifest.files.push('src');
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"files" ships [dist, src]; expected exactly [dist]');
  });

  it('rejects an ios directory in a package', () => {
    const failures = run(({ find }) => {
      find('verification-react-native').entries.push('ios');
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ships ios');
    expect(failures[0]).toContain('There is no iOS implementation');
  });

  it('rejects a podspec in a package', () => {
    const failures = run(({ find }) => {
      find('verification-react-native').entries.push('DidwwVerification.podspec');
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ships DidwwVerification.podspec');
  });

  // Both were absent from every manifest while the gate stayed green, and a checkout
  // cannot show the breakage: the same relative links resolve fine from the repository.
  it('rejects a package with no repository.url', () => {
    const failures = run(({ find }) => {
      delete find(CORE).manifest.repository;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no repository.url');
    expect(failures[0]).toContain('404s on the registry page');
  });

  it('rejects a repository.directory that is not the package directory', () => {
    const failures = run(({ find }) => {
      find(CORE).manifest.repository.directory = 'packages/wrong';
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('repository.directory is "packages/wrong"');
  });

  it('rejects a LICENSE that differs from the root by one byte', () => {
    const failures = run(({ find }) => {
      find(CORE).license = `${LICENSE.slice(0, -1)} \n`;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not byte-identical to the repository-root LICENSE');
  });

  it('rejects a package with no LICENSE of its own', () => {
    const failures = run(({ find }) => {
      find(CORE).license = null;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no LICENSE file in the package directory');
    expect(failures[0]).toContain('never reaches the tarball');
  });

  it('passes on the real repository', () => {
    const { status, output } = runGuard([]);
    expect(output).toContain('every package is publishable');
    expect(status).toBe(0);
  });
});
