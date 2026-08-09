import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSchemaCorpus,
  buildSchemaCorpusForDoc,
} from './schema-corpus';
import {
  SCHEMA_DEFINITIONS,
  type SchemaDoc,
} from './schemas';

function schemaDoc(properties: SchemaDoc['schema']['properties']): SchemaDoc {
  return {
    resource: 'Widget',
    kind: 'Widget',
    apiVersion: 'example.io/v1',
    version: 'v1',
    source: 'cluster',
    schema: { type: 'object', properties },
  };
}

test('schema corpus expresses dynamic map values without inventing child fields', () => {
  const chunks = buildSchemaCorpusForDoc(
    schemaDoc({
      labels: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    }),
  );

  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]!.text,
    /动态键值映射，键名不固定，值类型 string/u,
  );
  assert.deepEqual(chunks[0]!.targets, [
    { apiVersion: 'example.io/v1', kind: 'Widget', path: 'labels' },
  ]);
});

test('schema corpus resolves referenced map value semantics once', () => {
  const definition = 'test.local.Quantity';
  SCHEMA_DEFINITIONS.set(definition, {
    description: 'Fixed-point quantity.',
    oneOf: [{ type: 'string' }, { type: 'number' }],
  });

  try {
    const chunks = buildSchemaCorpusForDoc(
      schemaDoc({
        quota: {
          type: 'object',
          additionalProperties: {
            $ref: `#/components/schemas/${definition}`,
          },
        },
      }),
    );

    assert.equal(chunks.length, 1);
    assert.match(
      chunks[0]!.text,
      /动态键值映射，键名不固定，值类型 Quantity \(string \/ number\)/u,
    );
    assert.equal(
      chunks.some((chunk) => chunk.targets[0]?.path?.startsWith('quota.')),
      false,
    );
  } finally {
    SCHEMA_DEFINITIONS.delete(definition);
  }
});

test('curated ResourceQuota hard field preserves its Quantity map contract', () => {
  const chunk = buildSchemaCorpus().find(
    (candidate) =>
      candidate.id === 'schema::v1::ResourceQuota::spec.hard',
  );

  assert.ok(chunk);
  assert.match(
    chunk.text,
    /动态键值映射，键名不固定，值类型 Quantity \(string \/ number\)/u,
  );
});
