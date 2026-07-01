import { resolveSchemaNode, SCHEMA_DOCS, SCHEMA_DEFINITIONS, type SchemaNode } from '../src/knowledge/schemas';

interface Issue {
  key: string;
  message: string;
}

const issues: Issue[] = [];

function walk(node: SchemaNode | undefined, path: string, visit: (node: SchemaNode, path: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const resolved = resolveSchemaNode(node);
  visit(resolved, path);
  for (const [name, child] of Object.entries(resolved.properties ?? {})) {
    walk(child, path ? `${path}.${name}` : name, visit);
  }
  walk(resolved.items, `${path}[]`, visit);
}

function containsLocalRef(node: SchemaNode | undefined): boolean {
  if (!node || typeof node !== 'object') return false;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) return true;
  return (
    Object.values(node.properties ?? {}).some(containsLocalRef) ||
    containsLocalRef(node.items) ||
    (node.allOf ?? []).some(containsLocalRef) ||
    (node.anyOf ?? []).some(containsLocalRef) ||
    (node.oneOf ?? []).some(containsLocalRef)
  );
}

for (const doc of SCHEMA_DOCS) {
  const key = `${doc.apiVersion}/${doc.kind ?? doc.resource}`;
  const resolvedRoot = resolveSchemaNode(doc.schema);
  if (containsLocalRef(resolvedRoot)) {
    issues.push({ key, message: 'resolved schema still contains local $ref' });
  }

  const spec = resolvedRoot.properties?.spec ? resolveSchemaNode(resolvedRoot.properties.spec) : undefined;
  if (spec && !spec.properties) {
    issues.push({ key, message: 'resolved spec has no properties' });
  }

  let chunkableFields = 0;
  walk(doc.schema, '', (_node, path) => {
    if (path) chunkableFields++;
  });
  if (chunkableFields === 0) {
    issues.push({ key, message: 'schema has no chunkable fields after ref resolution' });
  }
}

if (SCHEMA_DEFINITIONS.size === 0) {
  issues.push({ key: '(registry)', message: 'definition registry is empty; generated/definitions was not loaded' });
}

if (issues.length > 0) {
  console.error('schema check failed: curated generated schemas are not fully consumable');
  for (const issue of issues) console.error(`- ${issue.key}: ${issue.message}`);
  process.exit(1);
}

console.log(`schema check passed: ${SCHEMA_DOCS.length} curated resource(s), ${SCHEMA_DEFINITIONS.size} definition(s) loaded`);
