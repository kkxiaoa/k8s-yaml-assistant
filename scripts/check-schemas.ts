import { resolveSchemaNode, SCHEMA_DOCS, SCHEMA_DEFINITIONS, type SchemaNode } from '../src/knowledge/schemas';

interface Issue {
  key: string;
  message: string;
}

const issues: Issue[] = [];
const MAX_CHECK_DEPTH = 64;

function walk(
  node: SchemaNode | undefined,
  path: string,
  visit: (node: SchemaNode, path: string) => void,
  depth = 0,
  activeRefs = new Set<string>(),
): void {
  if (!node || typeof node !== 'object') return;
  if (depth > MAX_CHECK_DEPTH) {
    throw new Error(`schema traversal exceeds ${MAX_CHECK_DEPTH} levels at ${path}`);
  }
  if (node.$ref && activeRefs.has(node.$ref)) return;
  const nextActiveRefs = node.$ref
    ? new Set([...activeRefs, node.$ref])
    : activeRefs;
  const resolved = resolveSchemaNode(node);
  visit(resolved, path);
  for (const [name, child] of Object.entries(resolved.properties ?? {})) {
    walk(
      child,
      path ? `${path}.${name}` : name,
      visit,
      depth + 1,
      nextActiveRefs,
    );
  }
  walk(resolved.items, `${path}[]`, visit, depth + 1, nextActiveRefs);
  if (
    resolved.additionalProperties &&
    typeof resolved.additionalProperties === 'object'
  ) {
    walk(
      resolved.additionalProperties,
      `${path}{}`,
      visit,
      depth + 1,
      nextActiveRefs,
    );
  }
  for (const [index, branch] of (resolved.anyOf ?? []).entries()) {
    walk(
      branch,
      `${path}.anyOf[${index}]`,
      visit,
      depth + 1,
      nextActiveRefs,
    );
  }
  for (const [index, branch] of (resolved.oneOf ?? []).entries()) {
    walk(
      branch,
      `${path}.oneOf[${index}]`,
      visit,
      depth + 1,
      nextActiveRefs,
    );
  }
}

for (const doc of SCHEMA_DOCS) {
  const key = `${doc.apiVersion}/${doc.kind ?? doc.resource}`;
  try {
    const resolvedRoot = resolveSchemaNode(doc.schema);

    const spec = resolvedRoot.properties?.spec
      ? resolveSchemaNode(resolvedRoot.properties.spec)
      : undefined;
    if (spec && !spec.properties) {
      issues.push({ key, message: 'resolved spec has no properties' });
    }

    let chunkableFields = 0;
    walk(doc.schema, '', (_node, path) => {
      if (path) chunkableFields++;
    });
    if (chunkableFields === 0) {
      issues.push({
        key,
        message: 'schema has no chunkable fields after ref resolution',
      });
    }
  } catch (error) {
    issues.push({
      key,
      message: `schema resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    });
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
