import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCorpusManifest, CORPUS } from '../src/knowledge/corpus';
import {
  decodeIndexManifest,
  readIndex,
  type IndexManifest,
} from '../src/retrieval/index-store';
import {
  RELEASE_INDEX_EMBEDDING_MODEL,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  assertBuildKitSlsaV1Provenance,
  decodeReleaseManifest,
  deriveIndexArtifactIdentity,
  resolveDraftReleaseIdentity,
  resolveReleasePreparation,
  resolveReleaseSourceState,
  verifyDraftRelease,
} from '../src/release/manifest';

type Options = Record<string, string>;

const jsonLimits = {
  sbom: 50 * 1024 * 1024,
  provenance: 2 * 1024 * 1024,
  bundle: 60 * 1024 * 1024,
  release: 2 * 1024 * 1024,
  manifest: 2 * 1024 * 1024,
} as const;

function parseOptions(args: readonly string[], allowed: readonly string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw new TypeError('release-manifest options must be --name value pairs');
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) {
      throw new TypeError(`unknown release-manifest option: ${flag}`);
    }
    if (options[name] !== undefined) {
      throw new TypeError(`duplicate release-manifest option: ${flag}`);
    }
    options[name] = value;
  }
  for (const name of allowed) {
    if (options[name] === undefined) {
      throw new TypeError(`missing release-manifest option: --${name}`);
    }
  }
  return options;
}

function readJson(path: string, maxBytes: number): unknown {
  const size = statSync(path).size;
  if (size === 0 || size > maxBytes) {
    throw new TypeError(`${path} must contain between 1 and ${maxBytes} bytes`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function currentReleaseSourceState() {
  return resolveReleaseSourceState({
    packageJson: JSON.parse(readFileSync('package.json', 'utf8')) as unknown,
    packageLock: JSON.parse(
      readFileSync('package-lock.json', 'utf8'),
    ) as unknown,
    releasePleaseManifest: JSON.parse(
      readFileSync('.release-please-manifest.json', 'utf8'),
    ) as unknown,
    changelog: existsSync('CHANGELOG.md')
      ? readFileSync('CHANGELOG.md', 'utf8')
      : null,
  });
}

function currentReleaseIdentity() {
  const sourceState = currentReleaseSourceState();
  if (sourceState.status === 'placeholder') {
    throw new TypeError('package version 0.0.0 is a release placeholder');
  }
  return sourceState.identity;
}

function appendGitHubOutputs(
  path: string,
  outputs: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(outputs)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new TypeError('GitHub output names and values must be single-line');
    }
    appendFileSync(path, `${name}=${value}\n`);
  }
}

function verifyIndexManifestIdentity(
  value: unknown,
  corpusManifest: ReturnType<typeof buildCorpusManifest>,
  embeddingModel: string,
): {
  manifest: IndexManifest;
  artifact: ReturnType<typeof deriveIndexArtifactIdentity>;
} {
  const manifest = decodeIndexManifest(value);
  const artifact = deriveIndexArtifactIdentity(
    corpusManifest,
    embeddingModel,
  );
  if (
    manifest.formatVersion !== artifact.formatVersion ||
    manifest.corpusIdentityVersion !== artifact.corpusIdentityVersion ||
    manifest.embeddingModel !== artifact.embeddingModel ||
    manifest.count !== corpusManifest.count ||
    manifest.corpusManifestHash !== corpusManifest.manifestHash ||
    manifest.indexHash !== artifact.indexHash
  ) {
    throw new TypeError('index identity does not match current corpus and model');
  }
  return { manifest, artifact };
}

function prepare(options: Options): void {
  const identity = currentReleaseIdentity();
  const draft = resolveDraftReleaseIdentity({
    release: readJson(options['release-json']!, jsonLimits.release),
    expectedTag: identity.tag,
    expectedSourceCommit: options['source-sha']!,
  });
  appendGitHubOutputs(resolve(options['github-output']!), {
    release_notes_sha256: draft.releaseNotesSha256,
  });
}

function check(): void {
  const identity = currentReleaseIdentity();
  console.log(
    JSON.stringify({
      version: identity.version,
      tag: identity.tag,
      changelogSha256: identity.changelogSha256,
    }),
  );
}

function gate(options: Options): void {
  const tagCommit =
    options['tag-commit'] === 'none' ? null : options['tag-commit']!;
  const decision = resolveReleasePreparation({
    sourceState: currentReleaseSourceState(),
    releases: readJson(options['releases-json']!, jsonLimits.release),
    associatedPullRequests: readJson(
      options['associated-prs-json']!,
      jsonLimits.release,
    ),
    headCommit: options['head-sha']!,
    currentTagCommit: tagCommit,
  });
  if (decision.historyBoundaryCommit !== null) {
    const ancestry = spawnSync(
      'git',
      [
        'merge-base',
        '--is-ancestor',
        decision.historyBoundaryCommit,
        options['head-sha']!,
      ],
      { stdio: 'ignore' },
    );
    if (ancestry.status !== 0) {
      throw new TypeError(
        'release history boundary is not an ancestor of the source commit',
      );
    }
  }
  appendGitHubOutputs(resolve(options['github-output']!), {
    release_action: decision.action,
  });
}

function indexIdentity(options: Options): void {
  const corpusManifest = buildCorpusManifest();
  const identity = deriveIndexArtifactIdentity(
    corpusManifest,
    RELEASE_INDEX_EMBEDDING_MODEL,
  );
  appendGitHubOutputs(resolve(options['github-output']!), {
    index_image: identity.name,
    index_tag: identity.tag,
    index_hash: identity.indexHash,
    embedding_model: identity.embeddingModel,
  });
}

function verifyIndex(options: Options): void {
  const embeddingModel = options['embedding-model']!;
  const corpusManifest = buildCorpusManifest();
  const expectation = {
    corpusManifest,
    corpusChunks: CORPUS,
    embeddingModel,
  };
  const result = readIndex(expectation, resolve(options['index-dir']!));
  if (result.status !== 'hit') {
    throw new TypeError(
      `index artifact is unavailable: ${result.reason}${result.detail === undefined ? '' : ` (${result.detail})`}`,
    );
  }
  console.log(
    JSON.stringify({
      indexHash: result.manifest.indexHash,
      count: result.manifest.count,
      embeddingModel: result.manifest.embeddingModel,
    }),
  );
}

function dockerBaseImages(dockerfile: string): {
  nodeBaseImage: string;
  runtimeBaseImage: string;
} {
  const node = dockerfile.match(/^FROM\s+(\S+)\s+AS\s+base\s*$/mu)?.[1];
  const runtime = dockerfile.match(
    /^FROM\s+(\S+)\s+AS\s+runtime-base\s*$/mu,
  )?.[1];
  if (node === undefined || runtime === undefined) {
    throw new TypeError('Dockerfile must declare base and runtime-base images');
  }
  return { nodeBaseImage: node, runtimeBaseImage: runtime };
}

function assertBoundedJson(
  path: string,
  maxBytes: number,
  label: string,
): { value: Record<string, unknown>; buffer: Buffer } {
  const buffer = readFileSync(path);
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new TypeError(`${label} exceeds its bounded artifact size`);
  }
  const value = object(JSON.parse(buffer.toString('utf8')), label);
  const text = buffer.toString('utf8');
  if (
    /(?:^|[\s"'`])(?:\/Users\/|\/home\/|\/root\/|\/private\/|[A-Za-z]:\\)/mu.test(
      text,
    ) ||
    /\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|COOKIE_SECRET)\s*[:=]\s*\S+/iu.test(
      text,
    )
  ) {
    throw new TypeError(`${label} contains forbidden local or secret material`);
  }
  return { value, buffer };
}

function finalize(options: Options): void {
  const identity = currentReleaseIdentity();
  const sourceCommit = options['source-sha']!;
  const draft = resolveDraftReleaseIdentity({
    release: readJson(options['release-json']!, jsonLimits.release),
    expectedTag: identity.tag,
    expectedSourceCommit: sourceCommit,
  });
  const imageDigest = options['image-digest']!;
  const workflowRunUrl = options['workflow-run-url']!;
  const currentProduction = options['current-production-digest']!;
  const corpusManifest = buildCorpusManifest();
  const verifiedIndex = verifyIndexManifestIdentity(
    readJson(options['index-manifest']!, 1024 * 1024),
    corpusManifest,
    options['embedding-model']!,
  );

  const sbom = assertBoundedJson(
    options.sbom!,
    jsonLimits.sbom,
    'SPDX SBOM',
  );
  if (
    sbom.value.spdxVersion !== 'SPDX-2.3' ||
    !Array.isArray(sbom.value.packages) ||
    sbom.value.packages.length === 0
  ) {
    throw new TypeError('SBOM must be a non-empty SPDX 2.3 document');
  }
  const provenance = assertBoundedJson(
    options.provenance!,
    jsonLimits.provenance,
    'SLSA provenance',
  );
  assertBuildKitSlsaV1Provenance(provenance.value);
  const sbomBundle = assertBoundedJson(
    options['sbom-bundle']!,
    jsonLimits.bundle,
    'SBOM attestation bundle',
  );
  const provenanceBundle = assertBoundedJson(
    options['provenance-bundle']!,
    jsonLimits.bundle,
    'provenance attestation bundle',
  );

  const packageData = object(
    JSON.parse(readFileSync('package.json', 'utf8')) as unknown,
    'package.json',
  );
  const dependencies = object(packageData.dependencies, 'package dependencies');
  const nodeVersion = readFileSync('.nvmrc', 'utf8').trim();
  const nextVersion = string(dependencies.next, 'Next.js version');
  const bases = dockerBaseImages(readFileSync('Dockerfile', 'utf8'));
  const previousDigest =
    currentProduction === 'none' ? null : currentProduction;

  const manifest = decodeReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: {
      version: identity.version,
      tag: identity.tag,
      sourceCommit,
      changelogPath: identity.changelogPath,
      changelogSha256: identity.changelogSha256,
      releaseNotesSha256: draft.releaseNotesSha256,
      manifestBundlePath: 'release-manifest.sigstore.json',
    },
    image: {
      name: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      digest: imageDigest,
      platform: 'linux/amd64',
    },
    build: {
      nodeVersion,
      nextVersion,
      repository: 'kkxiaoa/k8s-yaml-assistant',
      workflow: '.github/workflows/release-artifacts.yml',
      workflowRef:
        'kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      workflowRunUrl,
      ...bases,
    },
    corpus: {
      identityVersion: corpusManifest.identityVersion,
      count: corpusManifest.count,
      manifestHash: corpusManifest.manifestHash,
    },
    index: {
      formatVersion: verifiedIndex.manifest.formatVersion,
      corpusIdentityVersion: verifiedIndex.manifest.corpusIdentityVersion,
      embeddingModel: verifiedIndex.manifest.embeddingModel,
      dimension: verifiedIndex.manifest.dimension,
      count: verifiedIndex.manifest.count,
      indexHash: verifiedIndex.manifest.indexHash,
      chunksHash: verifiedIndex.manifest.chunksHash,
      embeddingsHash: verifiedIndex.manifest.embeddingsHash,
      createdAt: verifiedIndex.manifest.createdAt,
      artifact: {
        name: verifiedIndex.artifact.name,
        tag: verifiedIndex.artifact.tag,
        digest: options['index-artifact-digest']!,
        certificateIdentity:
          'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/index-build.yml@refs/heads/main',
        oidcIssuer: 'https://token.actions.githubusercontent.com',
      },
    },
    sbom: {
      path: 'sbom.spdx.json',
      format: 'spdx-2.3-json',
      sha256: sha256(sbom.buffer),
    },
    provenance: {
      path: 'provenance.slsa.json',
      sha256: sha256(provenance.buffer),
      predicateType: 'https://slsa.dev/provenance/v1',
    },
    attestations: {
      provider: 'sigstore-cosign',
      subjectDigest: imageDigest,
      certificateIdentity:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      sbom: {
        bundlePath: 'sbom-attestation.sigstore.json',
        bundleSha256: sha256(sbomBundle.buffer),
        predicateType: 'https://spdx.dev/Document',
      },
      provenance: {
        bundlePath: 'provenance-attestation.sigstore.json',
        bundleSha256: sha256(provenanceBundle.buffer),
        predicateType: 'https://slsa.dev/provenance/v1',
      },
    },
    deployment: {
      status: 'candidate',
      currentProductionDigest: previousDigest,
      rollback:
        previousDigest === null
          ? {
              eligible: false,
              digest: null,
              reason: 'not_deployed',
            }
          : {
              eligible: true,
              digest: previousDigest,
              reason: 'accepted',
            },
    },
  });
  writeText(options.out!, `${JSON.stringify(manifest, null, 2)}\n`);
}

function verifyDraft(options: Options): void {
  const manifest = decodeReleaseManifest(
    readJson(options['release-manifest']!, jsonLimits.manifest),
  );
  const sourceIdentity = currentReleaseIdentity();
  if (
    manifest.release.version !== sourceIdentity.version ||
    manifest.release.tag !== sourceIdentity.tag ||
    manifest.release.changelogSha256 !== sourceIdentity.changelogSha256 ||
    manifest.release.sourceCommit !== options['source-sha']! ||
    manifest.release.tag !== options.tag!
  ) {
    throw new TypeError('release manifest does not match the checked-out source');
  }
  const verified = verifyDraftRelease({
    release: readJson(options['release-json']!, jsonLimits.release),
    expectedTag: options.tag!,
    expectedSourceCommit: options['source-sha']!,
    expectedReleaseNotesSha256: manifest.release.releaseNotesSha256,
  });
  console.log(
    JSON.stringify({
      tag: verified.tagName,
      sourceCommit: verified.sourceCommit,
      releaseNotesSha256: verified.releaseNotesSha256,
      assets: verified.assets.map((asset) => asset.name),
    }),
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check' && args.length === 0) {
    check();
    return;
  }
  if (command === 'prepare') {
    prepare(
      parseOptions(args, ['release-json', 'source-sha', 'github-output']),
    );
    return;
  }
  if (command === 'gate') {
    gate(
      parseOptions(args, [
        'releases-json',
        'associated-prs-json',
        'head-sha',
        'tag-commit',
        'github-output',
      ]),
    );
    return;
  }
  if (command === 'index-identity') {
    indexIdentity(
      parseOptions(args, ['github-output']),
    );
    return;
  }
  if (command === 'verify-index') {
    verifyIndex(parseOptions(args, ['index-dir', 'embedding-model']));
    return;
  }
  if (command === 'finalize') {
    finalize(
      parseOptions(args, [
        'source-sha',
        'release-json',
        'image-digest',
        'workflow-run-url',
        'current-production-digest',
        'index-manifest',
        'embedding-model',
        'index-artifact-digest',
        'sbom',
        'provenance',
        'sbom-bundle',
        'provenance-bundle',
        'out',
      ]),
    );
    return;
  }
  if (command === 'verify-draft') {
    verifyDraft(
      parseOptions(args, [
        'release-json',
        'release-manifest',
        'source-sha',
        'tag',
      ]),
    );
    return;
  }
  throw new TypeError(
    'usage: release-manifest <check|gate|prepare|index-identity|verify-index|finalize|verify-draft> [options]',
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
