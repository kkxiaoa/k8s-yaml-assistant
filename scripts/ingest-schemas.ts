import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAll } from 'js-yaml';

interface SchemaNode {
  $ref?: string;
  allOf?: SchemaNode[];
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  [key: string]: unknown;
}

interface SchemaDoc {
  resource: string;
  apiVersion: string;
  group?: string;
  version?: string;
  kind: string;
  schema: SchemaNode;
  source: 'builtin' | 'cluster' | 'crd';
}

interface CrdVersion {
  name?: string;
  served?: boolean;
  schema?: { openAPIV3Schema?: SchemaNode };
}

interface CrdManifest {
  apiVersion?: string;
  kind?: string;
  spec?: {
    group?: string;
    names?: { kind?: string };
    versions?: CrdVersion[];
  };
}

interface OpenApiSchema {
  'x-kubernetes-group-version-kind'?: Array<{ group?: string; version?: string; kind?: string }>;
  [key: string]: unknown;
}

interface OpenApiDoc {
  components?: { schemas?: Record<string, OpenApiSchema> };
}

interface OpenApiV3Discovery {
  paths?: Record<string, { serverRelativeURL?: string }>;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function apiVersionOf(group: string | undefined, version: string): string {
  return group ? `${group}/${version}` : version;
}

function fileNameOf(doc: SchemaDoc): string {
  const group = doc.group || 'core';
  return `${group}.${doc.version ?? doc.apiVersion}.${doc.kind}.json`.replace(/\//g, '.');
}

function writeDocs(docs: SchemaDoc[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const doc of docs) {
    writeFileSync(join(outDir, fileNameOf(doc)), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

function fromSchemaDir(input: string): SchemaDoc[] {
  return readdirSync(input)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const raw = readFileSync(join(input, file), 'utf8');
      const parsed = JSON.parse(raw) as Partial<SchemaDoc>;
      const kind = parsed.kind ?? parsed.resource ?? basename(file, '.json');
      const apiVersion = parsed.apiVersion ?? 'unknown';
      const [group, version] = apiVersion.includes('/')
        ? (apiVersion.split('/') as [string, string])
        : ['', apiVersion];
      if (!parsed.schema) throw new Error(`${file} is missing schema`);
      return {
        resource: kind,
        kind,
        apiVersion,
        group: group || undefined,
        version,
        schema: parsed.schema,
        source: parsed.source ?? 'builtin',
      };
    });
}

function fromCrdFile(input: string): SchemaDoc[] {
  const text = readFileSync(input, 'utf8');
  const manifests = loadAll(text).filter(Boolean) as CrdManifest[];
  const docs: SchemaDoc[] = [];

  for (const manifest of manifests) {
    if (manifest.kind !== 'CustomResourceDefinition') continue;
    const group = manifest.spec?.group;
    const kind = manifest.spec?.names?.kind;
    if (!group || !kind) throw new Error(`Invalid CRD in ${input}: missing spec.group or spec.names.kind`);

    for (const version of manifest.spec?.versions ?? []) {
      const schema = version.schema?.openAPIV3Schema;
      if (!version.name || !schema || version.served === false) continue;
      docs.push({
        resource: kind,
        kind,
        apiVersion: apiVersionOf(group, version.name),
        group,
        version: version.name,
        schema,
        source: 'crd',
      });
    }
  }

  return docs;
}

function fromOpenApiFile(input: string, source: 'builtin' | 'cluster'): SchemaDoc[] {
  const openapi = JSON.parse(readFileSync(input, 'utf8')) as OpenApiDoc;
  return fromOpenApiDoc(openapi, source);
}

function rawKubectl(path: string): string {
  return execFileSync('kubectl', ['get', '--raw', path], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function isGroupVersionPath(path: string): boolean {
  return path === 'api/v1' || /^apis\/[^/]+\/[^/]+$/.test(path);
}

function fromClusterDiscovery(): SchemaDoc[] {
  const discovery = JSON.parse(rawKubectl('/openapi/v3')) as OpenApiV3Discovery;
  const entries = Object.entries(discovery.paths ?? {})
    .filter(([path, item]) => isGroupVersionPath(path) && item.serverRelativeURL)
    .sort(([a], [b]) => a.localeCompare(b));

  const docs: SchemaDoc[] = [];
  for (const [path, item] of entries) {
    const url = item.serverRelativeURL!;
    const openapi = JSON.parse(rawKubectl(url)) as OpenApiDoc;
    const before = docs.length;
    docs.push(...fromOpenApiDoc(openapi, 'cluster'));
    console.error(`Fetched ${path}: ${docs.length - before} schema doc(s)`);
  }
  return docs;
}

function fromOpenApiDoc(openapi: OpenApiDoc, source: 'builtin' | 'cluster'): SchemaDoc[] {
  const schemas = openapi.components?.schemas ?? {};
  const docs: SchemaDoc[] = [];

  for (const schema of Object.values(schemas)) {
    for (const gvk of schema['x-kubernetes-group-version-kind'] ?? []) {
      if (!gvk.version || !gvk.kind) continue;
      const resolved = resolveSchema(schema as SchemaNode, schemas, new Set());
      docs.push({
        resource: gvk.kind,
        kind: gvk.kind,
        apiVersion: apiVersionOf(gvk.group, gvk.version),
        group: gvk.group || undefined,
        version: gvk.version,
        schema: resolved,
        source,
      });
    }
  }

  return docs;
}

function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function mergeSchemas(items: SchemaNode[]): SchemaNode {
  const merged: SchemaNode = {};
  for (const item of items) {
    Object.assign(merged, item);
    if (item.properties) merged.properties = { ...(merged.properties ?? {}), ...item.properties };
    if (item.required) merged.required = Array.from(new Set([...(merged.required ?? []), ...item.required]));
    if (!merged.description && item.description) merged.description = item.description;
    if (!merged.type && item.type) merged.type = item.type;
  }
  return merged;
}

function resolveSchema(
  node: SchemaNode,
  schemas: Record<string, OpenApiSchema>,
  seen: Set<string>,
): SchemaNode {
  if (node.$ref) {
    const name = refName(node.$ref);
    if (!name || seen.has(name)) return { description: node.description, type: node.type };
    const target = schemas[name] as SchemaNode | undefined;
    if (!target) return { description: node.description, type: node.type };
    return resolveSchema(target, schemas, new Set([...seen, name]));
  }

  const base = node.allOf
    ? mergeSchemas(node.allOf.map((item) => resolveSchema(item, schemas, seen)))
    : { ...node };
  delete base.$ref;
  delete base.allOf;

  if (base.properties) {
    base.properties = Object.fromEntries(
      Object.entries(base.properties).map(([key, child]) => [key, resolveSchema(child, schemas, seen)]),
    );
  }
  if (base.items) base.items = resolveSchema(base.items, schemas, seen);
  return base;
}

function main(): void {
  const source = requireArg('source');
  const outDir = arg('out') ?? join('data', 'schemas', 'generated');
  const input = arg('input') ?? process.argv[process.argv.length - 1];
  let docs: SchemaDoc[];

  if (source === 'dir') {
    docs = fromSchemaDir(requireArg('input'));
  } else if (source === 'crd') {
    docs = fromCrdFile(input);
  } else if (source === 'kubernetes') {
    docs = fromOpenApiFile(requireArg('input'), 'builtin');
  } else if (source === 'cluster') {
    docs = fromOpenApiFile(requireArg('input'), 'cluster');
  } else if (source === 'cluster-discovery') {
    docs = fromClusterDiscovery();
  } else {
    throw new Error(`Unsupported --source ${source}. Use dir, crd, kubernetes, cluster, or cluster-discovery.`);
  }

  if (docs.length === 0) throw new Error(`No schema docs generated from ${input}`);
  writeDocs(docs, outDir);
  console.error(`Generated ${docs.length} schema doc(s) into ${outDir}`);
}

main();
