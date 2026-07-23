import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

const root = process.cwd();
const workflowPath = join(root, '.github', 'workflows', 'pr-verify.yml');
const codeownersPath = join(root, '.github', 'CODEOWNERS');
const checkoutAction =
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeAction =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const requiredCommands = [
  'npm ci',
  'npm run schemas:check',
  'npm run aliases:check',
  'npm run corpus:closure',
  'npm run eval:check',
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run container:build:runtime-base',
  'npm run container:smoke:runtime-base',
] as const;
const forbiddenNpmCommands = [
  'npm run index:build',
  'npm run eval',
  'npm run eval:faith',
  'npm run eval:judge',
  'npm run eval:gen',
  'npm run eval:fix',
  'npm run voyage:ab',
  'npm run aliases:ab',
] as const;

type JsonObject = Record<string, unknown>;

interface WorkflowBundle {
  workflow: JsonObject;
  source: string;
  codeowners: string;
}

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function parseWorkflow(source: string): JsonObject {
  return object(load(source), 'workflow');
}

function workflowSteps(workflow: JsonObject): JsonObject[] {
  const jobs = object(workflow.jobs, 'jobs');
  const verify = object(jobs.verify, 'jobs.verify');
  assert.ok(Array.isArray(verify.steps), 'jobs.verify.steps must be an array');
  return verify.steps.map((step, index) =>
    object(step, `jobs.verify.steps[${index}]`),
  );
}

function appendWorkflowStep(workflow: JsonObject, step: JsonObject): void {
  const jobs = object(workflow.jobs, 'jobs');
  const verify = object(jobs.verify, 'jobs.verify');
  assert.ok(Array.isArray(verify.steps), 'jobs.verify.steps must be an array');
  verify.steps.push(step);
}

function commandLines(steps: readonly JsonObject[]): string[] {
  return steps.flatMap((step) =>
    typeof step.run === 'string'
      ? step.run
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [],
  );
}

function assertCodeowners(source: string): void {
  const rules = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  assert.deepEqual(rules, [
    '* @kkxiaoa',
    '/.github/ @kkxiaoa',
    '/Dockerfile @kkxiaoa',
    '/deploy/ @kkxiaoa',
  ]);
}

function validateWorkflow(workflow: JsonObject, source: string): void {
  exactKeys(
    workflow,
    ['name', 'on', 'permissions', 'concurrency', 'jobs'],
    'workflow',
  );
  assert.equal(workflow.name, 'PR verify');

  const triggers = object(workflow.on, 'on');
  exactKeys(triggers, ['pull_request'], 'on');
  const pullRequest = object(triggers.pull_request, 'on.pull_request');
  assert.deepEqual(pullRequest, { branches: ['main'] });

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: '${{ github.workflow }}-${{ github.event.pull_request.number }}',
    'cancel-in-progress': true,
  });

  const jobs = object(workflow.jobs, 'jobs');
  exactKeys(jobs, ['verify'], 'jobs');
  const verify = object(jobs.verify, 'jobs.verify');
  exactKeys(
    verify,
    ['name', 'runs-on', 'timeout-minutes', 'steps'],
    'jobs.verify',
  );
  assert.equal(verify.name, 'PR verify');
  assert.equal(verify['runs-on'], 'ubuntu-24.04');
  assert.ok(
    Number.isInteger(verify['timeout-minutes']) &&
      Number(verify['timeout-minutes']) > 0 &&
      Number(verify['timeout-minutes']) <= 60,
    'jobs.verify.timeout-minutes must be between 1 and 60',
  );

  const steps = workflowSteps(workflow);
  assert.ok(steps.length > 0, 'workflow must contain steps');
  for (const [index, step] of steps.entries()) {
    if (typeof step.uses === 'string') {
      exactKeys(step, ['name', 'uses', 'with'], `action step ${index}`);
    } else {
      exactKeys(step, ['name', 'run'], `run step ${index}`);
    }
  }

  const actionSteps = steps.filter(
    (step): step is JsonObject & { uses: string } =>
      typeof step.uses === 'string',
  );
  assert.deepEqual(
    actionSteps.map((step) => step.uses),
    [checkoutAction, setupNodeAction],
  );
  for (const step of actionSteps) {
    assert.match(step.uses, /^[^@\s]+@[a-f0-9]{40}$/u);
  }

  const checkout = actionSteps[0]!;
  assert.deepEqual(checkout.with, {
    'persist-credentials': false,
  });
  const setupNode = actionSteps[1]!;
  assert.deepEqual(setupNode.with, {
    'node-version-file': '.nvmrc',
    cache: 'npm',
    'cache-dependency-path': 'package-lock.json',
  });

  const commands = commandLines(steps);
  for (const command of requiredCommands) {
    assert.ok(commands.includes(command), `workflow missing command: ${command}`);
  }
  for (const command of commands) {
    assert.equal(
      forbiddenNpmCommands.some(
        (forbidden) =>
          command === forbidden || command.startsWith(`${forbidden} `),
      ),
      false,
      `workflow contains model/index command: ${command}`,
    );
    assert.doesNotMatch(command, /\bdocker\s+(?:login|push)\b/u);
    assert.doesNotMatch(command, /\bdocker\s+buildx\s+build\b.*\s--push(?:\s|$)/u);
  }

  assert.doesNotMatch(source, /\bpull_request_target\b/u);
  assert.doesNotMatch(source, /\bself-hosted\b/u);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /\$\{\{\s*vars\./u);
  assert.doesNotMatch(source, /\$\{\{\s*github\.token\s*\}\}/u);
  assert.doesNotMatch(
    source,
    /\b(?:VOYAGE|DEEPSEEK)_[A-Z0-9_]+\b/u,
  );
  assert.doesNotMatch(source, /\bghcr\.io\b/u);
}

function readActualBundle(): WorkflowBundle {
  assert.ok(existsSync(workflowPath), `${workflowPath} must exist`);
  assert.ok(existsSync(codeownersPath), `${codeownersPath} must exist`);
  const source = readFileSync(workflowPath, 'utf8');
  return {
    workflow: parseWorkflow(source),
    source,
    codeowners: readFileSync(codeownersPath, 'utf8'),
  };
}

test('repository pull request workflow satisfies the no-secret security contract', () => {
  const bundle = readActualBundle();
  validateWorkflow(bundle.workflow, bundle.source);
  assertCodeowners(bundle.codeowners);
});

test('workflow contract rejects privileged triggers, runners, permissions and configuration', () => {
  const source = readActualBundle();
  const mutations: Array<(workflow: JsonObject) => void> = [
    (workflow) => {
      workflow.on = { pull_request_target: { branches: ['main'] } };
    },
    (workflow) => {
      object(object(workflow.jobs, 'jobs').verify, 'verify')['runs-on'] =
        'self-hosted';
    },
    (workflow) => {
      workflow.permissions = { contents: 'write' };
    },
    (workflow) => {
      object(object(workflow.jobs, 'jobs').verify, 'verify').environment =
        'production';
    },
    (workflow) => {
      object(object(workflow.jobs, 'jobs').verify, 'verify').env = {
        TOKEN: '${{ secrets.PRODUCTION_TOKEN }}',
      };
    },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(source.workflow);
    mutate(candidate);
    assert.throws(() =>
      validateWorkflow(candidate, JSON.stringify(candidate)),
    );
  }
});

test('workflow contract rejects mutable actions and persisted checkout credentials', () => {
  const source = readActualBundle();

  const mutableAction = structuredClone(source.workflow);
  workflowSteps(mutableAction)[0]!.uses = 'actions/checkout@v7';
  assert.throws(() =>
    validateWorkflow(mutableAction, JSON.stringify(mutableAction)),
  );

  const persistedCredentials = structuredClone(source.workflow);
  workflowSteps(persistedCredentials)[0]!.with = {
    'persist-credentials': true,
  };
  assert.throws(() =>
    validateWorkflow(
      persistedCredentials,
      JSON.stringify(persistedCredentials),
    ),
  );
});

test('workflow contract rejects missing gates, model commands and image pushes', () => {
  const source = readActualBundle();
  for (const required of requiredCommands) {
    const candidate = structuredClone(source.workflow);
    const step = workflowSteps(candidate).find((item) => item.run === required);
    assert.ok(step, `test fixture missing command step: ${required}`);
    step.run = 'true';
    assert.throws(() =>
      validateWorkflow(candidate, JSON.stringify(candidate)),
    );
  }

  for (const forbidden of [
    'npm run index:build',
    'npm run eval:faith',
    'docker login ghcr.io',
    'docker push ghcr.io/kkxiaoa/k8s-yaml-assistant:test',
  ]) {
    const candidate = structuredClone(source.workflow);
    appendWorkflowStep(candidate, { name: 'forbidden', run: forbidden });
    assert.throws(
      () => validateWorkflow(candidate, JSON.stringify(candidate)),
      `contract accepted forbidden command: ${forbidden}`,
    );
  }
});
