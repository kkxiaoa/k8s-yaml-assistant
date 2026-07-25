import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_INDEX_EMBEDDING_MODEL } from '../src/release/manifest';

const NODE_IMAGE_DIGEST =
  'sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
const RUNTIME_IMAGE_DIGEST =
  'sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e';
const REQUIRED_STAGES = [
  'deps',
  'verify',
  'index-build',
  'index-artifact',
  'build',
  'runtime-base',
  'runtime',
] as const;
const REQUIRED_IGNORES = [
  '.env',
  '.git',
  'node_modules',
  '.next',
  'data/index',
  'data/observability',
  'data/eval/runs',
  'data/eval/traces',
] as const;
export const REVIEWED_WORKTREE_CONTEXT_FILES = [
  '.github/workflows/index-build.yml',
  '.github/workflows/release-artifacts.yml',
  '.github/workflows/release.yml',
  '.release-please-manifest.json',
  '.dockerignore',
  'Dockerfile',
  'release-please-config.json',
  'scripts/container-smoke.ts',
  'scripts/container-smoke.test.ts',
  'scripts/release-manifest-cli.test.ts',
  'scripts/release-manifest.ts',
  'src/release/manifest.test.ts',
  'src/release/manifest.ts',
] as const;
const LOCAL_IMAGE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const APP_UID_GID = '10001:10001';
const TMP_SIZE_BYTES = 64 * 1024 * 1024;
const CANDIDATE_INDEX_PATHS = new Set([
  'app/data/index/manifest.json',
  'app/data/index/chunks.jsonl',
  'app/data/index/embeddings.f32',
]);

interface ContainerBuildContract {
  dockerfile: string;
  dockerignore: string;
  trackedSchemaPaths: readonly string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ImageInspect {
  Config?: {
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[];
    Cmd?: string[];
    Env?: string[];
    Volumes?: Record<string, unknown>;
  };
}

interface ContainerInspect {
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
    NetworkMode?: string;
  };
}

interface HealthResponse {
  status: number;
  body: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

function dockerignoreRules(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function globExpression(pattern: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(expression, 'u');
}

function dockerignoreRuleMatches(rule: string, path: string): boolean {
  const normalizedRule = rule.replace(/^\//u, '').replace(/\/$/u, '');
  if (normalizedRule.length === 0) return false;
  const expression = globExpression(normalizedRule).source;
  return normalizedRule.includes('/')
    ? new RegExp(`^${expression}(?:/.*)?$`, 'u').test(path)
    : new RegExp(`(?:^|/)${expression}(?:/|$)`, 'u').test(path);
}

function isDockerIgnored(path: string, rules: readonly string[]): boolean {
  let ignored = false;
  for (const rawRule of rules) {
    const negated = rawRule.startsWith('!');
    const rule = negated ? rawRule.slice(1) : rawRule;
    if (dockerignoreRuleMatches(rule, path)) ignored = !negated;
  }
  return ignored;
}

function dockerfileInstructions(content: string): string[] {
  const logicalLines: string[] = [];
  let current = '';
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    current = current.length === 0 ? line : `${current} ${line}`;
    if (current.endsWith('\\')) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    logicalLines.push(current);
    current = '';
  }
  if (current.length > 0) logicalLines.push(current);
  return logicalLines;
}

function parseStages(instructions: readonly string[]): Map<string, string[]> {
  const stages = new Map<string, string[]>();
  let current: string | undefined;
  for (const instruction of instructions) {
    const from = /^FROM\s+(\S+)\s+AS\s+(\S+)$/iu.exec(instruction);
    if (from) {
      current = from[2]!.toLowerCase();
      stages.set(current, [instruction]);
      continue;
    }
    if (current) stages.get(current)!.push(instruction);
  }
  return stages;
}

function requireStageText(
  stages: ReadonlyMap<string, string[]>,
  stage: string,
): string {
  const instructions = stages.get(stage);
  if (!instructions) fail(`Dockerfile missing ${stage} stage`);
  return instructions.join('\n');
}

export function assertContainerBuildContract(
  contract: ContainerBuildContract,
): void {
  const ignoreRules = dockerignoreRules(contract.dockerignore);
  for (const path of REQUIRED_IGNORES) {
    const probe = path.includes('.') && !path.includes('/')
      ? path
      : `${path}/contract-probe`;
    if (!isDockerIgnored(probe, ignoreRules)) {
      fail(`.dockerignore must exclude ${path}`);
    }
  }
  for (const path of contract.trackedSchemaPaths) {
    if (isDockerIgnored(path, ignoreRules)) {
      fail(`.dockerignore excludes tracked schema closure path ${path}`);
    }
  }

  const instructions = dockerfileInstructions(contract.dockerfile);
  const stages = parseStages(instructions);
  for (const stage of REQUIRED_STAGES) requireStageText(stages, stage);

  const knownStages = new Set(stages.keys());
  for (const instruction of instructions) {
    const from = /^FROM\s+(\S+)\s+AS\s+(\S+)$/iu.exec(instruction);
    if (
      !from ||
      from[1]!.toLowerCase() === 'scratch' ||
      knownStages.has(from[1]!.toLowerCase())
    ) {
      continue;
    }
    if (!/@sha256:[a-f0-9]{64}$/u.test(from[1]!)) {
      fail(`external base image must use a sha256 digest: ${from[1]}`);
    }
  }
  if (!contract.dockerfile.includes(NODE_IMAGE_DIGEST)) {
    fail('Node base image digest is not the reviewed identity');
  }
  if (!contract.dockerfile.includes(RUNTIME_IMAGE_DIGEST)) {
    fail('runtime base image digest is not the reviewed identity');
  }

  const deps = requireStageText(stages, 'deps');
  if (!/\bRUN npm ci\b/u.test(deps) || /\bnpm install\b/u.test(deps)) {
    fail('deps stage must install dependencies with npm ci only');
  }
  const verify = requireStageText(stages, 'verify');
  if (!verify.includes('RUN npm test') || !verify.includes('RUN npm run typecheck')) {
    fail('verify stage must run tests and TypeScript typecheck');
  }
  const index = requireStageText(stages, 'index-build');
  if (
    !index.includes(
      '--mount=type=secret,id=voyage_api_key,required=true',
    )
  ) {
    fail('index-build stage must use the required BuildKit secret mount');
  }
  if (!index.includes('npm run index:build')) {
    fail('index-build stage must build the real corpus index');
  }
  if (/^\s*(?:ARG|ENV)\s+.*VOYAGE_API_KEY/im.test(contract.dockerfile)) {
    fail('VOYAGE_API_KEY must not be declared by ARG or ENV');
  }

  const build = requireStageText(stages, 'build');
  if (!build.includes('RUN --network=none npm run build')) {
    fail('Next build must run with network disabled');
  }
  const indexArtifact = requireStageText(stages, 'index-artifact');
  if (
    !indexArtifact.startsWith('FROM scratch AS index-artifact') ||
    !indexArtifact.includes(
      'COPY --from=index-build /app/data/index /data/index',
    )
  ) {
    fail('index-artifact must contain only the independently built index');
  }
  const runtimeBase = requireStageText(stages, 'runtime-base');
  for (const required of [
    'COPY --from=build --chown=10001:10001 /app/.next/standalone ./',
    'COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static',
    `USER ${APP_UID_GID}`,
    'ENTRYPOINT ["/usr/local/bin/node"]',
    'CMD ["server.js"]',
  ]) {
    if (!runtimeBase.includes(required)) {
      fail(`runtime-base stage missing: ${required}`);
    }
  }
  const runtime = requireStageText(stages, 'runtime');
  if (!runtime.startsWith('FROM runtime-base AS runtime')) {
    fail('runtime stage must inherit the tested runtime-base stage');
  }
  if (
    !runtime.includes(
      'COPY --from=verified-index --chown=10001:10001 /data/index ./data/index',
    ) ||
    runtime.includes('COPY --from=index-build')
  ) {
    fail('runtime stage must consume the immutable verified-index build context');
  }
}

export function assertLocalSmokeImageReference(image: string): void {
  if (!LOCAL_IMAGE.test(image) || image.endsWith(':latest')) {
    fail('local smoke image must use a non-latest explicit tag');
  }
}

export function assertImmutableDeploymentImageReference(image: string): void {
  if (!IMMUTABLE_IMAGE.test(image)) {
    fail('deployment image must use an immutable sha256 digest');
  }
}

export function findForbiddenRuntimePaths(
  paths: readonly string[],
  options: { allowCandidateIndex?: boolean } = {},
): string[] {
  return paths.filter((rawPath) => {
    const path = rawPath.replace(/^\.\//u, '').replace(/\/$/u, '');
    const basename = posix.basename(path);
    const isTypeScriptSource =
      /\.[cm]?tsx?$/u.test(path) && !/\.d\.[cm]?ts$/u.test(path);
    return (
      path === 'app/.git' ||
      path.startsWith('app/.git/') ||
      basename === '.env' ||
      basename.startsWith('.env.') ||
      path.startsWith('app/src/') ||
      path.startsWith('app/scripts/') ||
      /(?:^|\/)tests?(?:\/|$)/u.test(path) ||
      /\.test\.[cm]?[jt]sx?$/u.test(path) ||
      isTypeScriptSource ||
      path.startsWith('app/node_modules/typescript/') ||
      path.startsWith('app/.npm/') ||
      (path.startsWith('app/data/index/') &&
        (!options.allowCandidateIndex || !CANDIDATE_INDEX_PATHS.has(path))) ||
      path.startsWith('app/data/observability/') ||
      path.startsWith('app/data/eval/runs/') ||
      path.startsWith('app/data/eval/traces/') ||
      path.startsWith('run/secrets/') ||
      path.startsWith('var/run/secrets/kubernetes.io/serviceaccount/')
    );
  });
}

function run(
  command: string,
  args: readonly string[],
  options: { allowFailure?: boolean; maxBuffer?: number } = {},
): CommandResult & { status: number } {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  const output = {
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (status !== 0 && !options.allowFailure) {
    fail(
      `${command} ${args.join(' ')} failed (${status})\n${output.stderr || output.stdout}`,
    );
  }
  return output;
}

function gitTrackedFiles(root: string): string[] {
  const result = run('git', ['ls-files', '--cached', '-z'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout
    .split('\0')
    .filter((path) => path.length > 0 && existsSync(join(root, path)));
}

export function selectBuildContextPaths(
  trackedPaths: readonly string[],
  reviewedWorktreePaths: readonly string[],
): string[] {
  const paths = Array.from(new Set([...trackedPaths, ...reviewedWorktreePaths]));
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.includes('\0') ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.startsWith('../')
    ) {
      fail(`unsafe build context path: ${path}`);
    }
  }
  return paths.sort();
}

function copyBuildContextFile(root: string, target: string, path: string): void {
  const sourcePath = resolve(root, path);
  const relativePath = relative(root, sourcePath);
  if (
    relativePath.startsWith('..') ||
    relativePath === '' ||
    relativePath.includes('\0')
  ) {
    fail(`unsafe build context path: ${path}`);
  }
  const targetPath = join(target, relativePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  const stat = lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), targetPath);
    return;
  }
  if (!stat.isFile()) fail(`unsupported tracked build context entry: ${path}`);
  copyFileSync(sourcePath, targetPath);
}

function prepareTrackedBuildContext(root: string): {
  directory: string;
  digest: string;
  paths: string[];
} {
  const directory = mkdtempSync(join(tmpdir(), 'k8s-yaml-assistant-context-'));
  try {
    const paths = selectBuildContextPaths(
      gitTrackedFiles(root),
      REVIEWED_WORKTREE_CONTEXT_FILES.filter((path) =>
        existsSync(join(root, path)),
      ),
    );
    for (const path of paths) copyBuildContextFile(root, directory, path);

    const hash = createHash('sha256');
    for (const path of paths) {
      hash.update(path).update('\0');
      const absolutePath = join(root, path);
      const stat = lstatSync(absolutePath);
      hash.update(stat.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath));
      hash.update('\0');
    }
    return { directory, digest: hash.digest('hex'), paths };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function runInteractive(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status ?? 1})`);
  }
}

function validateRepositoryContract(root: string): void {
  const trackedSchemaPaths = gitTrackedFiles(root).filter((path) =>
    path.startsWith('data/schemas/generated/'),
  );
  assertContainerBuildContract({
    dockerfile: readFileSync(join(root, 'Dockerfile'), 'utf8'),
    dockerignore: readFileSync(join(root, '.dockerignore'), 'utf8'),
    trackedSchemaPaths,
  });
}

function buildRuntimeBase(root: string, image: string): void {
  assertLocalSmokeImageReference(image);
  validateRepositoryContract(root);
  const context = prepareTrackedBuildContext(root);
  try {
    console.log(
      `tracked build context: ${context.paths.length} files, sha256:${context.digest}`,
    );
    runInteractive('docker', [
      'buildx',
      'build',
      '--load',
      '--target',
      'runtime-base',
      '--tag',
      image,
      context.directory,
    ]);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
}

function parseInspect<T>(command: string, args: readonly string[]): T {
  const output = run(command, args).stdout;
  const decoded = JSON.parse(output) as T[];
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    fail(`unexpected ${command} inspect response`);
  }
  return decoded[0]!;
}

function nodeInContainer(name: string, source: string): CommandResult & { status: number } {
  return run(
    'docker',
    ['exec', name, '/usr/local/bin/node', '-e', source],
    { allowFailure: true },
  );
}

async function waitForHealth(
  name: string,
  path: string,
  timeoutMs = 30_000,
): Promise<HealthResponse> {
  const deadline = Date.now() + timeoutMs;
  const source = `fetch('http://127.0.0.1:3000${path}').then(async response => console.log(JSON.stringify({status: response.status, body: await response.json()}))).catch(() => process.exit(2))`;
  while (Date.now() < deadline) {
    const result = nodeInContainer(name, source);
    if (result.status === 0) {
      return JSON.parse(result.stdout.trim()) as HealthResponse;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`health endpoint ${path} did not respond within ${timeoutMs}ms`);
}

function assertImageConfig(image: string): void {
  const inspect = parseInspect<ImageInspect>('docker', ['image', 'inspect', image]);
  const config = inspect.Config;
  if (!config) fail('image inspect is missing Config');
  if (config.User !== APP_UID_GID) fail(`image user must be ${APP_UID_GID}`);
  if (config.WorkingDir !== '/app') fail('image working directory must be /app');
  if (JSON.stringify(config.Entrypoint) !== JSON.stringify(['/usr/local/bin/node'])) {
    fail('image entrypoint must be the pinned Node binary');
  }
  if (JSON.stringify(config.Cmd) !== JSON.stringify(['server.js'])) {
    fail('image command must be server.js');
  }
  if (config.Volumes && Object.keys(config.Volumes).length > 0) {
    fail('runtime image must not declare implicit volumes');
  }
  const leakedEnvironment = (config.Env ?? []).filter((entry) =>
    /(?:API_KEY|TOKEN|SECRET|PASSWORD)=/u.test(entry),
  );
  if (leakedEnvironment.length > 0) {
    fail(`runtime image contains secret environment fields: ${leakedEnvironment.join(', ')}`);
  }
}

function assertContainerIsolation(name: string): void {
  const inspect = parseInspect<ContainerInspect>('docker', ['inspect', name]);
  if (!inspect.HostConfig?.ReadonlyRootfs) fail('container root filesystem is writable');
  if (inspect.HostConfig.NetworkMode !== 'none') fail('smoke container must have no network');
  const tmpfs = inspect.HostConfig.Tmpfs?.['/tmp'];
  if (!tmpfs || !tmpfs.includes(`size=${TMP_SIZE_BYTES}`)) {
    fail('/tmp must use a bounded 64 MiB tmpfs');
  }

  const identity = nodeInContainer(
    name,
    "console.log(`${process.getuid?.()}:${process.getgid?.()}`)",
  );
  if (identity.status !== 0 || identity.stdout.trim() !== APP_UID_GID) {
    fail(`runtime process identity must be ${APP_UID_GID}`);
  }

  const appWrite = nodeInContainer(
    name,
    "const fs=require('node:fs');try{fs.writeFileSync('/app/.write-probe','x');process.exit(2)}catch(error){console.log(error.code)}",
  );
  if (appWrite.status !== 0 || appWrite.stdout.trim() !== 'EROFS') {
    fail('/app must reject writes with EROFS');
  }
  const tmpWrite = nodeInContainer(
    name,
    "const fs=require('node:fs');fs.writeFileSync('/tmp/write-probe','x');fs.unlinkSync('/tmp/write-probe')",
  );
  if (tmpWrite.status !== 0) fail('/tmp must support bounded runtime writes');

  const serviceAccount = nodeInContainer(
    name,
    "const fs=require('node:fs');console.log(fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'))",
  );
  if (serviceAccount.status !== 0 || serviceAccount.stdout.trim() !== 'false') {
    fail('runtime must start without a ServiceAccount token');
  }
}

function assertRuntimeContents(
  name: string,
  allowCandidateIndex: boolean,
): void {
  const auditRoot = mkdtempSync(join(tmpdir(), 'k8s-yaml-assistant-image-audit-'));
  const archive = join(auditRoot, 'rootfs.tar');
  try {
    run('docker', ['export', '--output', archive, name]);
    const paths = run('tar', ['-tf', archive], {
      maxBuffer: 64 * 1024 * 1024,
    }).stdout
      .split(/\r?\n/u)
      .filter((path) => path.length > 0)
      .map((path) => path.replace(/^\.\//u, '').replace(/\/$/u, ''));
    const forbidden = findForbiddenRuntimePaths(paths, {
      allowCandidateIndex,
    });
    if (forbidden.length > 0) {
      fail(`runtime image contains forbidden paths:\n${forbidden.join('\n')}`);
    }
    for (const required of [
      'app/server.js',
      'app/data/policies.json',
      'app/data/aliases/schema-field-aliases.jsonl',
      'app/data/schemas/generated/resources/core.v1.Pod.json',
      ...(allowCandidateIndex ? CANDIDATE_INDEX_PATHS : []),
    ]) {
      if (!paths.includes(required)) fail(`runtime image missing ${required}`);
    }
    for (const forbiddenTool of [
      'bin/sh',
      'bin/bash',
      'usr/bin/curl',
      'usr/bin/apt',
      'usr/bin/apt-get',
      'usr/bin/dpkg',
      'usr/local/bin/npm',
      'usr/local/bin/npx',
    ]) {
      if (paths.includes(forbiddenTool)) {
        fail(`runtime image contains forbidden tool ${forbiddenTool}`);
      }
    }
  } finally {
    rmSync(auditRoot, { recursive: true, force: true });
  }
}

async function smokeRuntime(
  image: string,
  expectation: 'ready' | 'not-ready',
): Promise<void> {
  const expectReady = expectation === 'ready';
  if (expectReady) {
    assertImmutableDeploymentImageReference(image);
  } else {
    assertLocalSmokeImageReference(image);
  }
  assertImageConfig(image);
  const name = `k8s-yaml-assistant-smoke-${randomUUID()}`;
  try {
    run('docker', [
      'run',
      '--detach',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,nodev,size=${TMP_SIZE_BYTES}`,
      '--network',
      'none',
      '--env',
      'NODE_ENV=production',
      '--env',
      'PORT=3000',
      '--env',
      'HOSTNAME=0.0.0.0',
      '--env',
      'DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic',
      '--env',
      'DEEPSEEK_ANSWER_MODEL=deepseek-v4-flash',
      '--env',
      'VOYAGE_EMBEDDING_URL=https://api.voyageai.com/v1/embeddings',
      '--env',
      'VOYAGE_RERANK_URL=https://api.voyageai.com/v1/rerank',
      '--env',
      `VOYAGE_EMBEDDING_MODEL=${RELEASE_INDEX_EMBEDDING_MODEL}`,
      '--env',
      'VOYAGE_RERANK_MODEL=rerank-2.5',
      '--env',
      'VOYAGE_API_KEY=container-smoke-non-secret',
      '--env',
      'INDEX_DIR=/app/data/index',
      '--env',
      'ENABLE_QUERY_EXPANSION=true',
      '--env',
      'SERVING_OBSERVATION_MODE=off',
      image,
    ]);

    const live = await waitForHealth(name, '/api/health/live');
    if (live.status !== 200 || JSON.stringify(live.body) !== '{"status":"live"}') {
      fail(`unexpected liveness response: ${JSON.stringify(live)}`);
    }
    const ready = await waitForHealth(
      name,
      '/api/health/ready',
      expectReady ? 60_000 : 30_000,
    );
    if (expectReady) {
      if (
        ready.status !== 200 ||
        JSON.stringify(ready.body) !== '{"status":"ready"}'
      ) {
        fail(`candidate runtime must be ready: ${JSON.stringify(ready)}`);
      }
    } else if (
      ready.status !== 503 ||
      JSON.stringify(ready.body) !==
        '{"status":"not_ready","code":"index_missing"}'
    ) {
      fail(
        `runtime-base must fail readiness on index_missing: ${JSON.stringify(ready)}`,
      );
    }

    assertContainerIsolation(name);
    assertRuntimeContents(name, expectReady);
    console.log(
      expectReady
        ? 'candidate smoke passed: live=200, ready=200, provider network=none'
        : 'runtime-base smoke passed: live=200, ready=503/index_missing, provider network=none',
    );
  } finally {
    run('docker', ['rm', '--force', name], { allowFailure: true });
  }
}

export function parseContainerSmokeArguments(argv: readonly string[]): {
  image: string;
  mode: 'build-runtime-base' | 'expect-not-ready' | 'expect-ready';
} {
  let image = '';
  let mode:
    | 'build-runtime-base'
    | 'expect-not-ready'
    | 'expect-ready'
    | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--image') {
      image = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--build-runtime-base') {
      if (mode) fail('container command accepts exactly one mode');
      mode = 'build-runtime-base';
    } else if (argument === '--expect-not-ready') {
      if (mode) fail('container command accepts exactly one mode');
      mode = 'expect-not-ready';
    } else if (argument === '--expect-ready') {
      if (mode) fail('container command accepts exactly one mode');
      mode = 'expect-ready';
    } else {
      fail(`unknown container command argument: ${argument}`);
    }
  }
  if (!mode) fail('container command mode is required');
  if (mode === 'expect-ready') {
    assertImmutableDeploymentImageReference(image);
  } else {
    assertLocalSmokeImageReference(image);
  }
  return { image, mode };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arguments_ = parseContainerSmokeArguments(process.argv.slice(2));
  if (arguments_.mode === 'build-runtime-base') {
    buildRuntimeBase(root, arguments_.image);
    return;
  }
  await smokeRuntime(
    arguments_.image,
    arguments_.mode === 'expect-ready' ? 'ready' : 'not-ready',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
