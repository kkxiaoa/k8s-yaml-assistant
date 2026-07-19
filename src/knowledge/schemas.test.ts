import assert from 'node:assert/strict';
import {
  resolveSchemaNode,
  SCHEMA_DEFINITIONS,
  type SchemaNode,
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

console.log('schema resolution:');

check('当前层解析保留子节点引用并允许下降时继续解析', () => {
  const parentName = 'test.local.Parent';
  const childName = 'test.local.Child';
  SCHEMA_DEFINITIONS.set(parentName, {
    type: 'object',
    properties: {
      child: { $ref: `#/components/schemas/${childName}` },
    },
  });
  SCHEMA_DEFINITIONS.set(childName, { type: 'string', enum: ['ok'] });

  try {
    const parent = resolveSchemaNode({
      $ref: `#/components/schemas/${parentName}`,
    });
    const child = parent.properties?.child;
    assert.deepEqual(child, {
      $ref: `#/components/schemas/${childName}`,
    });
    assert.deepEqual(resolveSchemaNode(child as SchemaNode), {
      type: 'string',
      enum: ['ok'],
    });
  } finally {
    SCHEMA_DEFINITIONS.delete(parentName);
    SCHEMA_DEFINITIONS.delete(childName);
  }
});

check('缺失和非本地引用明确失败而不是退化为空 schema', () => {
  assert.throws(
    () =>
      resolveSchemaNode({
        $ref: '#/components/schemas/test.local.Missing',
      }),
    /schema definition 不存在.*test\.local\.Missing/,
  );
  assert.throws(
    () => resolveSchemaNode({ $ref: 'https://example.test/schema.json' }),
    /不支持的 schema \$ref/,
  );
});

check('当前层直接引用环明确失败', () => {
  const firstName = 'test.local.First';
  const secondName = 'test.local.Second';
  SCHEMA_DEFINITIONS.set(firstName, {
    $ref: `#/components/schemas/${secondName}`,
  });
  SCHEMA_DEFINITIONS.set(secondName, {
    $ref: `#/components/schemas/${firstName}`,
  });

  try {
    assert.throws(
      () =>
        resolveSchemaNode({
          $ref: `#/components/schemas/${firstName}`,
        }),
      /schema \$ref 直接成环/,
    );
  } finally {
    SCHEMA_DEFINITIONS.delete(firstName);
    SCHEMA_DEFINITIONS.delete(secondName);
  }
});

console.log(`\n通过 ${passed} 项`);
