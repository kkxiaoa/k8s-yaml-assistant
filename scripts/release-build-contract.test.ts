import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const expectedNodeVersion = '24.18.0';
const expectedNodeTypesVersion = '24.13.3';
const expectedJsYamlVersion = '4.3.0';
const expectedNextVersion = '16.2.12';
const expectedPostcssVersion = '8.5.23';
const expectedSharpVersion = '0.35.3';
const expectedLicense = 'Apache-2.0';
const fontExtensions = new Set(['.otf', '.ttf', '.woff', '.woff2']);

type JsonObject = Record<string, unknown>;

type ReleaseBuildBundle = {
  nodeVersion: string;
  packageJson: JsonObject;
  lockRoot: JsonObject;
  resolvedJsYaml: JsonObject;
  resolvedNext: JsonObject;
  resolvedPostcssVersions: string[];
  resolvedSharpVersions: string[];
  nextConfig: JsonObject;
  tsConfig: JsonObject;
  appSources: Record<string, string>;
  fontAssets: string[];
};

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

function collectFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: Dirent) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    },
  );
}

async function readActualBundle(): Promise<ReleaseBuildBundle> {
  const lockfile = readJson(join(root, 'package-lock.json'));
  const packages = lockfile.packages as JsonObject;
  const sourceFiles = collectFiles(join(root, 'app')).filter((path) =>
    ['.css', '.ts', '.tsx'].includes(extname(path)),
  );
  const fontAssets = [join(root, 'app'), join(root, 'public')]
    .flatMap(collectFiles)
    .filter((path) => fontExtensions.has(extname(path)))
    .map((path) => relative(root, path));
  const configModule = (await import(
    `${pathToFileURL(join(root, 'next.config.mjs')).href}?release-contract`
  )) as { default: JsonObject };

  return {
    nodeVersion: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
    packageJson: readJson(join(root, 'package.json')),
    lockRoot: packages[''] as JsonObject,
    resolvedJsYaml: packages['node_modules/js-yaml'] as JsonObject,
    resolvedNext: packages['node_modules/next'] as JsonObject,
    resolvedPostcssVersions: Object.entries(packages)
      .filter(([path]) => /(?:^|\/)node_modules\/postcss$/u.test(path))
      .map(([, value]) => (value as JsonObject).version as string)
      .sort(),
    resolvedSharpVersions: Object.entries(packages)
      .filter(([path]) => /(?:^|\/)node_modules\/sharp$/u.test(path))
      .map(([, value]) => (value as JsonObject).version as string)
      .sort(),
    nextConfig: configModule.default,
    tsConfig: readJson(join(root, 'tsconfig.json')),
    appSources: Object.fromEntries(
      sourceFiles.map((path) => [relative(root, path), readFileSync(path, 'utf8')]),
    ),
    fontAssets,
  };
}

function validateReleaseBuild(bundle: ReleaseBuildBundle): void {
  assert.equal(bundle.nodeVersion, expectedNodeVersion);
  assert.equal(bundle.packageJson.license, expectedLicense);
  assert.equal(bundle.lockRoot.license, expectedLicense);

  const engines = bundle.packageJson.engines as JsonObject | undefined;
  const lockEngines = bundle.lockRoot.engines as JsonObject | undefined;
  const devDependencies = bundle.packageJson.devDependencies as
    | JsonObject
    | undefined;
  const lockDevDependencies = bundle.lockRoot.devDependencies as
    | JsonObject
    | undefined;
  const dependencies = bundle.packageJson.dependencies as JsonObject | undefined;
  const lockDependencies = bundle.lockRoot.dependencies as
    | JsonObject
    | undefined;
  const overrides = bundle.packageJson.overrides as JsonObject | undefined;
  assert.equal(engines?.node, expectedNodeVersion);
  assert.equal(lockEngines?.node, expectedNodeVersion);
  assert.equal(devDependencies?.['@types/node'], expectedNodeTypesVersion);
  assert.equal(lockDevDependencies?.['@types/node'], expectedNodeTypesVersion);
  assert.equal(dependencies?.['js-yaml'], expectedJsYamlVersion);
  assert.equal(lockDependencies?.['js-yaml'], expectedJsYamlVersion);
  assert.equal(bundle.resolvedJsYaml.version, expectedJsYamlVersion);
  assert.equal(dependencies?.next, expectedNextVersion);
  assert.equal(lockDependencies?.next, expectedNextVersion);
  assert.equal(bundle.resolvedNext.version, expectedNextVersion);
  assert.equal(overrides?.postcss, expectedPostcssVersion);
  assert.deepEqual(bundle.resolvedPostcssVersions, [expectedPostcssVersion]);
  assert.equal(overrides?.sharp, expectedSharpVersion);
  assert.deepEqual(bundle.resolvedSharpVersions, [expectedSharpVersion]);
  assert.equal(bundle.nextConfig.output, 'standalone');
  const compilerOptions = bundle.tsConfig.compilerOptions as
    | JsonObject
    | undefined;
  assert.equal(compilerOptions?.noUnusedLocals, true);
  assert.equal(compilerOptions?.noUnusedParameters, true);

  for (const [path, source] of Object.entries(bundle.appSources)) {
    assert.doesNotMatch(source, /from\s+['"]next\/font(?:\/[^'"]+)?['"]/, path);
    assert.doesNotMatch(source, /--font-plex-(?:mono|sans)/, path);
  }

  assert.deepEqual(bundle.fontAssets, []);

  const globalCss = bundle.appSources['app/globals.css'];
  assert.ok(globalCss);
  assert.match(globalCss, /--font-mono:\s*ui-monospace,/);
  assert.match(globalCss, /--font-sans:\s*ui-sans-serif,\s*system-ui,/);
}

function cloneReleaseBuildBundle(
  source: ReleaseBuildBundle,
): ReleaseBuildBundle {
  return {
    ...source,
    packageJson: structuredClone(source.packageJson),
    lockRoot: structuredClone(source.lockRoot),
    resolvedJsYaml: structuredClone(source.resolvedJsYaml),
    resolvedNext: structuredClone(source.resolvedNext),
    resolvedPostcssVersions: [...source.resolvedPostcssVersions],
    resolvedSharpVersions: [...source.resolvedSharpVersions],
    nextConfig: { ...source.nextConfig },
    tsConfig: structuredClone(source.tsConfig),
    appSources: { ...source.appSources },
    fontAssets: [...source.fontAssets],
  };
}

test('release build uses the pinned runtime, standalone output, and system fonts', async () => {
  validateReleaseBuild(await readActualBundle());
});

test('release build contract rejects version, output, and font regressions', async (t) => {
  const source = await readActualBundle();

  await t.test('package runtime differs from .nvmrc', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.packageJson.engines = { node: '24.17.0' };
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('Node types differ from the pinned runtime major', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const devDependencies = candidate.packageJson.devDependencies as JsonObject;
    devDependencies['@types/node'] = '25.9.2';
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('Next.js returns to the vulnerable release', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const dependencies = candidate.packageJson.dependencies as JsonObject;
    dependencies.next = '16.2.9';
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('js-yaml returns to the vulnerable release', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const dependencies = candidate.packageJson.dependencies as JsonObject;
    dependencies['js-yaml'] = '4.2.0';
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('postcss security override is removed', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const overrides = candidate.packageJson.overrides as JsonObject;
    delete overrides.postcss;
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('lockfile resolves a vulnerable postcss copy', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.resolvedPostcssVersions = ['8.4.31', expectedPostcssVersion];
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('sharp security override is removed', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const overrides = candidate.packageJson.overrides as JsonObject;
    delete overrides.sharp;
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('lockfile resolves a vulnerable sharp copy', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.resolvedSharpVersions = ['0.34.5', expectedSharpVersion];
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('standalone output is disabled', () => {
    const candidate = cloneReleaseBuildBundle(source);
    delete candidate.nextConfig.output;
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('unused code checks are disabled', () => {
    const candidate = cloneReleaseBuildBundle(source);
    const compilerOptions = candidate.tsConfig.compilerOptions as JsonObject;
    compilerOptions.noUnusedLocals = false;
    compilerOptions.noUnusedParameters = false;
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('Google font import is restored', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.appSources['app/layout.tsx'] =
      "import { IBM_Plex_Sans } from 'next/font/google';";
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('font binary is added to the application', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.fontAssets.push('app/fonts/custom.woff2');
    assert.throws(() => validateReleaseBuild(candidate));
  });

  await t.test('legacy IBM Plex variable is restored', () => {
    const candidate = cloneReleaseBuildBundle(source);
    candidate.appSources['app/globals.css'] =
      '--font-mono: var(--font-plex-mono), ui-monospace, monospace;';
    assert.throws(() => validateReleaseBuild(candidate));
  });
});
