import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { readJsonFile } from '../src/shared/json';

type DependencySection = 'dependencies' | 'devDependencies';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

const root = process.cwd();
const packageJson = readJsonFile(
  join(root, 'package.json'),
  'package manifest',
) as PackageManifest;
const packageLock = readJsonFile(
  join(root, 'package-lock.json'),
  'package lockfile',
) as PackageLock;
const lockRoot = packageLock.packages?.[''];
const sections: DependencySection[] = ['dependencies', 'devDependencies'];

test('direct dependencies do not use the floating latest tag', () => {
  const floating = sections.flatMap((section) =>
    Object.entries(packageJson[section] ?? {})
      .filter(([, specifier]) => specifier === 'latest')
      .map(([name]) => `${section}.${name}`),
  );

  assert.deepEqual(floating, []);
});

test('package manifest and lockfile root declare identical direct dependencies', () => {
  assert.ok(lockRoot, 'package-lock.json must contain the root package entry');

  for (const section of sections) {
    assert.deepEqual(lockRoot[section] ?? {}, packageJson[section] ?? {});
  }
});

test('exact direct dependency pins match their resolved lockfile versions', () => {
  for (const section of sections) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier)) {
        continue;
      }

      const resolved = packageLock.packages?.[`node_modules/${name}`]?.version;
      assert.equal(
        resolved,
        specifier,
        `${section}.${name} must match its resolved lockfile version`,
      );
    }
  }
});
