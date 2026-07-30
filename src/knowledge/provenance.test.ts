import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { decodeKnowledgeChunk, type SourceAuthority } from './chunk';
import { CORPUS } from './corpus';
import { buildSchemaCorpusForDoc } from './schema-corpus';
import {
  resolveSchemaNode,
  SCHEMA_DOCS,
  type SchemaDoc,
  type SchemaNode,
  type SchemaSource,
} from './schemas';

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

function schemaDoc(source: SchemaSource): SchemaDoc {
  return {
    resource: 'Widget',
    kind: 'Widget',
    apiVersion: 'example.io/v1',
    version: 'v1',
    source,
    schema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Widget spec. More info: https://example.test/widget',
        },
      },
    },
  };
}

function onlyAuthority(source: SchemaSource): SourceAuthority {
  const chunks = buildSchemaCorpusForDoc(schemaDoc(source));
  assert.equal(chunks.length, 1);
  return chunks[0]!.provenance.authority;
}

function generatedSchemaDoc(file: string): SchemaDoc {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'schemas', 'generated', 'resources', file), 'utf8'),
  ) as SchemaDoc;
}

function schemaNodeAtPath(
  schema: SchemaNode,
  path: readonly string[],
): SchemaNode | undefined {
  let current = resolveSchemaNode(schema);
  for (const segment of path) {
    const child = current.properties?.[segment];
    if (child === undefined) return undefined;
    const resolved = resolveSchemaNode(child);
    current = resolved.items ? resolveSchemaNode(resolved.items) : resolved;
  }
  return current;
}

console.log('knowledge provenance:');

check('schema source 映射为独立 authority，cluster/CRD 不冒充官方', () => {
  assert.equal(onlyAuthority('builtin'), 'kubernetes_official');
  assert.equal(onlyAuthority('cluster'), 'cluster_api');
  assert.equal(onlyAuthority('crd'), 'extension_provider');
});

check('curated 目标 CRD 复用完整 cluster schema', () => {
  const targets = [
    {
      file: 'gateway.networking.k8s.io.v1.HTTPRoute.json',
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      path: ['spec', 'rules', 'backendRefs', 'weight'],
    },
    {
      file: 'cert-manager.io.v1.Certificate.json',
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      path: ['spec', 'issuerRef'],
    },
  ] as const;

  for (const target of targets) {
    const doc = generatedSchemaDoc(target.file);
    assert.equal(doc.apiVersion, target.apiVersion);
    assert.equal(doc.kind, target.kind);
    assert.equal(doc.source, 'cluster');
    assert.ok(Object.keys(doc.schema.properties ?? {}).length > 0);
    assert.ok(
      schemaNodeAtPath(doc.schema, target.path),
      `${target.apiVersion}/${target.kind} missing ${target.path.join('.')}`,
    );
  }
});

check('curated cluster CRD chunk 保持 cluster_api authority', () => {
  for (const id of [
    'schema::gateway.networking.k8s.io/v1::HTTPRoute::spec.rules.backendRefs.weight',
    'schema::cert-manager.io/v1::Certificate::spec.issuerRef',
  ]) {
    const chunk = CORPUS.find((candidate) => candidate.id === id);
    assert.ok(chunk, `missing corpus chunk: ${id}`);
    assert.equal(chunk.provenance.authority, 'cluster_api');
    assert.notEqual(chunk.provenance.authority, 'kubernetes_official');
  }
});

check('schema chunk 使用 canonical ID、target 与 provenance', () => {
  const chunk = buildSchemaCorpusForDoc(schemaDoc('cluster'))[0]!;
  assert.equal(
    chunk.id,
    'schema::example.io/v1::Widget::spec',
  );
  assert.deepEqual(chunk.targets, [
    { apiVersion: 'example.io/v1', kind: 'Widget', path: 'spec' },
  ]);
  assert.deepEqual(chunk.provenance, {
    authority: 'cluster_api',
    sourceUri: 'https://example.test/widget',
    version: 'v1',
  });
  assert.equal('apiVersion' in chunk.provenance, false);
});

check('当前 corpus 全部满足严格 runtime contract 且无旧字段', () => {
  const legacyFields = [
    'resource',
    'path',
    'resources',
    'paths',
    'appliesTo',
    'sourceUri',
    'version',
    'trustLevel',
  ];
  for (const chunk of CORPUS) {
    assert.deepEqual(decodeKnowledgeChunk(chunk), chunk, chunk.id);
    for (const field of legacyFields) {
      assert.equal(field in chunk, false, `${chunk.id} contains ${field}`);
    }
  }
});

check('提交代码、eval 与 alias 数据不包含旧 schema chunk ID', () => {
  const root = process.cwd();
  const kinds = [...new Set(SCHEMA_DOCS.map((doc) => doc.kind ?? doc.resource))]
    .sort((left, right) => right.length - left.length)
    .map((kind) => kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const oldId = new RegExp(
    `(?<![:A-Za-z0-9_])(?:${kinds})::[A-Za-z0-9_][A-Za-z0-9_.-]*(?![A-Za-z0-9_.-])`,
    'g',
  );
  const files: string[] = [];

  function collect(path: string, extension: RegExp): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) collect(child, extension);
      else if (extension.test(entry.name)) files.push(child);
    }
  }

  for (const directory of ['src', 'scripts', 'app']) {
    collect(join(root, directory), /\.(?:ts|tsx)$/);
  }
  files.push(
    join(root, 'data/aliases/schema-field-alias-targets.json'),
    join(root, 'data/aliases/schema-field-aliases.jsonl'),
    join(root, 'data/eval/bad-cases.jsonl'),
  );
  const calibrationLabels = join(
    root,
    'data/eval/judge-calibration-labels.jsonl',
  );
  if (existsSync(calibrationLabels)) files.push(calibrationLabels);

  const stale = files.flatMap((file) => {
    const content = readFileSync(file, 'utf8');
    return [...content.matchAll(oldId)].map((match) => {
      const path = relative(root, file).split(sep).join('/');
      const line = content.slice(0, match.index).split('\n').length;
      return `${path}:${line} ${match[0]}`;
    });
  });
  assert.deepEqual(stale, []);
});

console.log(`\n通过 ${passed} 项`);
