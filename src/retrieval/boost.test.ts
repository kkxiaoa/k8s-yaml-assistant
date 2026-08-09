import assert from 'node:assert/strict';
import type { Chunk } from '../knowledge/corpus';
import { matchesDirectSchemaChild, policyBoost } from './boost';
import { POLICY_RELATED_BOOST } from './router';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

function chunk(
  sourceType: Chunk['sourceType'],
  kind: string,
  path?: string,
): Chunk {
  return {
    id:
      sourceType === 'policy'
        ? `policy.${kind.toLowerCase()}.test`
        : `schema::v1::${kind}::${path ?? 'spec'}`,
    title: `${kind} test`,
    text: 'test knowledge',
    sourceType,
    provenance: {
      authority:
        sourceType === 'policy' ? 'organization' : 'kubernetes_official',
    },
    targets: [{ kind, ...(path === undefined ? {} : { path }) }],
  };
}

const policyChunk = chunk('policy', 'Deployment', 'spec.replicas');
const resourceLevelPolicyChunk = chunk('policy', 'Pod');
const schemaChunk = chunk('schema', 'Deployment', 'spec.replicas');

console.log('policyBoost:');

check('policy + resource 匹配时加基础权重', () => {
  assert.equal(
    policyBoost(policyChunk, 'Deployment'),
    POLICY_RELATED_BOOST,
  );
});

check('policy + resource/path 同时匹配时叠加 path 权重', () => {
  assert.ok(
    policyBoost(policyChunk, 'Deployment', 'spec.replicas') >
      POLICY_RELATED_BOOST,
  );
});

check('不匹配 resource、schema 或无 hint 时不加权', () => {
  assert.equal(policyBoost(policyChunk, 'Service'), 0);
  assert.equal(policyBoost(schemaChunk, 'Deployment'), 0);
  assert.equal(policyBoost(policyChunk), 0);
});

check('资源级 policy 不会因伪造空 path 命中字段 bonus', () => {
  assert.equal(
    policyBoost(resourceLevelPolicyChunk, 'Pod', 'spec.hostNetwork'),
    POLICY_RELATED_BOOST,
  );
});

check('versioned policy 不匹配 apiVersion hint 时不加权', () => {
  const versionedPolicy: Chunk = {
    ...policyChunk,
    targets: [
      {
        apiVersion: 'apps/v2',
        kind: 'Deployment',
        path: 'spec.replicas',
      },
    ],
  };
  assert.equal(
    policyBoost(
      versionedPolicy,
      'Deployment',
      'spec.replicas',
      'apps/v1',
    ),
    0,
  );
});

check('只匹配同资源同版本的直接 schema 子字段', () => {
  const directChild: Chunk = {
    ...schemaChunk,
    targets: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        path: 'spec.selector.matchLabels',
      },
    ],
  };
  const grandchild: Chunk = {
    ...directChild,
    targets: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        path: 'spec.selector.matchExpressions.operator',
      },
    ],
  };

  assert.equal(
    matchesDirectSchemaChild(
      directChild,
      'Deployment',
      'spec.selector',
      'apps/v1',
    ),
    true,
  );
  assert.equal(
    matchesDirectSchemaChild(
      grandchild,
      'Deployment',
      'spec.selector',
      'apps/v1',
    ),
    false,
  );
  assert.equal(
    matchesDirectSchemaChild(
      directChild,
      'StatefulSet',
      'spec.selector',
      'apps/v1',
    ),
    false,
  );
  assert.equal(
    matchesDirectSchemaChild(
      directChild,
      'Deployment',
      'spec.selector',
      'apps/v2',
    ),
    false,
  );
});

check('policy 与父字段自身不属于直接 schema 子字段', () => {
  assert.equal(
    matchesDirectSchemaChild(
      policyChunk,
      'Deployment',
      'spec',
      undefined,
    ),
    false,
  );
  assert.equal(
    matchesDirectSchemaChild(
      schemaChunk,
      'Deployment',
      'spec.replicas',
      undefined,
    ),
    false,
  );
});

console.log(`\n通过 ${passed} 项`);
