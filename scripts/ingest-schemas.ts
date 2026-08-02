import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAll } from 'js-yaml';
import {
  writeSchemaArtifacts,
  type SchemaIngestionSource,
} from '../src/knowledge/schema-artifacts';

interface SchemaNode {
  $ref?: string;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  type?: string;
  description?: string;
  default?: unknown;
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
  definitionName?: string;
}

interface IngestBundle {
  docs: SchemaDoc[];
  definitions: Record<string, SchemaNode>;
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

interface OpenApiSchema extends SchemaNode {
  'x-kubernetes-group-version-kind'?: Array<{ group?: string; version?: string; kind?: string }>;
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

function resourceFileNameOf(doc: SchemaDoc): string {
  const group = doc.group || 'core';
  return `${group}.${doc.version ?? doc.apiVersion}.${doc.kind}.json`.replace(/\//g, '.');
}

function definitionFileNameOf(name: string): string {
  return `${name}.json`.replace(/\//g, '.');
}

function writeBundle(
  bundle: IngestBundle,
  outDir: string,
  source: SchemaIngestionSource,
): { resources: number; definitions: number; removed: number } {
  const resources = new Map<string, SchemaDoc>();
  for (const doc of bundle.docs) {
    resources.set(resourceFileNameOf(doc), doc);
  }
  const definitions = new Map<string, SchemaNode>();
  for (const [name, schema] of Object.entries(bundle.definitions)) {
    definitions.set(definitionFileNameOf(name), schema);
  }
  const result = writeSchemaArtifacts(
    { source, resources, definitions },
    outDir,
  );
  return {
    resources: resources.size,
    definitions: definitions.size,
    removed: result.removedFiles.length,
  };
}

function fromSchemaDir(input: string): IngestBundle {
  const docs = readdirSync(input)
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
      } satisfies SchemaDoc;
    });
  return { docs, definitions: {} };
}

function fromCrdFile(input: string): IngestBundle {
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

  return { docs, definitions: {} };
}

function fromOpenApiFile(input: string, source: 'builtin' | 'cluster'): IngestBundle {
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

function mergeBundles(target: IngestBundle, next: IngestBundle): void {
  target.docs.push(...next.docs);
  Object.assign(target.definitions, next.definitions);
}

function fromClusterDiscovery(): IngestBundle {
  const discovery = JSON.parse(rawKubectl('/openapi/v3')) as OpenApiV3Discovery;
  const entries = Object.entries(discovery.paths ?? {})
    .filter(([path, item]) => isGroupVersionPath(path) && item.serverRelativeURL)
    .sort(([a], [b]) => a.localeCompare(b));

  const bundle: IngestBundle = { docs: [], definitions: {} };
  for (const [path, item] of entries) {
    const url = item.serverRelativeURL!;
    const openapi = JSON.parse(rawKubectl(url)) as OpenApiDoc;
    const before = bundle.docs.length;
    mergeBundles(bundle, fromOpenApiDoc(openapi, 'cluster'));
    console.error(`Fetched ${path}: ${bundle.docs.length - before} schema doc(s)`);
  }
  return bundle;
}

function fromOpenApiDoc(openapi: OpenApiDoc, source: 'builtin' | 'cluster'): IngestBundle {
  const schemas = openapi.components?.schemas ?? {};
  const docs: SchemaDoc[] = [];

  for (const [definitionName, schema] of Object.entries(schemas)) {
    for (const gvk of schema['x-kubernetes-group-version-kind'] ?? []) {
      if (!gvk.version || !gvk.kind) continue;
      docs.push({
        resource: gvk.kind,
        kind: gvk.kind,
        apiVersion: apiVersionOf(gvk.group, gvk.version),
        group: gvk.group || undefined,
        version: gvk.version,
        schema,
        source,
        definitionName,
      });
    }
  }

  return { docs, definitions: schemas as Record<string, SchemaNode> };
}

function main(): void {
  const source = requireArg('source');
  const outDir = requireArg('out');
  const input = arg('input') ?? process.argv[process.argv.length - 1]!;
  let bundle: IngestBundle;
  let ingestionSource: SchemaIngestionSource;

  if (source === 'dir') {
    ingestionSource = 'dir';
    bundle = fromSchemaDir(requireArg('input'));
  } else if (source === 'crd') {
    ingestionSource = 'crd';
    bundle = fromCrdFile(input);
  } else if (source === 'kubernetes') {
    ingestionSource = 'kubernetes';
    bundle = fromOpenApiFile(requireArg('input'), 'builtin');
  } else if (source === 'cluster') {
    ingestionSource = 'cluster';
    bundle = fromOpenApiFile(requireArg('input'), 'cluster');
  } else if (source === 'cluster-discovery') {
    ingestionSource = 'cluster-discovery';
    bundle = fromClusterDiscovery();
  } else {
    throw new Error(`Unsupported --source ${source}. Use dir, crd, kubernetes, cluster, or cluster-discovery.`);
  }

  if (bundle.docs.length === 0) throw new Error(`No schema docs generated from ${input}`);
  const written = writeBundle(bundle, outDir, ingestionSource);
  console.error(
    `Generated ${written.resources} resource file(s) and ${written.definitions} definition file(s) into ${outDir}; removed ${written.removed} stale owned file(s)`,
  );
}

main();
