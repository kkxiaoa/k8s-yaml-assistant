import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../shared/json';

export const SCHEMA_ARTIFACT_MANIFEST_VERSION = 1 as const;

const ArtifactFileNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
    'must be a direct JSON child filename',
  );

const OwnedFileNamesSchema = z
  .array(ArtifactFileNameSchema)
  .refine((files) => new Set(files).size === files.length, {
    message: 'must not contain duplicate filenames',
  })
  .refine(
    (files) =>
      files.every(
        (file, index) => index === 0 || files[index - 1]! < file,
      ),
    { message: 'must use stable lexical order' },
  );

export const SchemaIngestionSourceSchema = z.enum([
  'dir',
  'crd',
  'kubernetes',
  'cluster',
  'cluster-discovery',
]);

export type SchemaIngestionSource = z.infer<
  typeof SchemaIngestionSourceSchema
>;

export const SchemaArtifactManifestSchema = z.strictObject({
  formatVersion: z.literal(SCHEMA_ARTIFACT_MANIFEST_VERSION),
  owner: z.literal('ingest-schemas'),
  source: SchemaIngestionSourceSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  layout: z.literal('resources+definitions'),
  ownedFiles: z.strictObject({
    resources: OwnedFileNamesSchema,
    definitions: OwnedFileNamesSchema,
  }),
});

export type SchemaArtifactManifest = z.infer<
  typeof SchemaArtifactManifestSchema
>;

export interface SchemaArtifactSnapshot {
  source: SchemaIngestionSource;
  resources: ReadonlyMap<string, unknown>;
  definitions: ReadonlyMap<string, unknown>;
}

export interface SchemaArtifactWriteResult {
  manifest: SchemaArtifactManifest;
  removedFiles: string[];
}

interface ArtifactDirectories {
  resources: string;
  definitions: string;
}

function artifactDirectories(outDir: string): ArtifactDirectories {
  return {
    resources: join(outDir, 'resources'),
    definitions: join(outDir, 'definitions'),
  };
}

function sortedEntries(
  entries: ReadonlyMap<string, unknown>,
  kind: 'resource' | 'definition',
): Array<[string, unknown]> {
  const result = [...entries.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [fileName, value] of result) {
    if (!ArtifactFileNameSchema.safeParse(fileName).success) {
      throw new TypeError(`invalid ${kind} artifact filename: ${fileName}`);
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new TypeError(
        `${kind} artifact ${fileName} is not JSON-serializable`,
        { cause: error },
      );
    }
    if (serialized === undefined) {
      throw new TypeError(
        `${kind} artifact ${fileName} is not JSON-serializable`,
      );
    }
  }
  return result;
}

function directJsonEntries(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

function decodeManifest(value: unknown, path: string): SchemaArtifactManifest {
  const decoded = SchemaArtifactManifestSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error(
      `schema artifact manifest does not declare safe artifact ownership at ${path}: ${decoded.error.message}`,
      { cause: decoded.error },
    );
  }
  return decoded.data;
}

export function readSchemaArtifactManifest(
  outDir: string,
): SchemaArtifactManifest {
  const path = join(outDir, 'manifest.json');
  return decodeManifest(readJsonFile(path, 'schema artifact manifest'), path);
}

function previousManifest(
  outDir: string,
  directories: ArtifactDirectories,
): SchemaArtifactManifest | null {
  const path = join(outDir, 'manifest.json');
  if (existsSync(path)) {
    return decodeManifest(
      readJsonFile(path, 'schema artifact manifest'),
      path,
    );
  }

  const existing = [
    ...directJsonEntries(directories.resources).map(
      (file) => `resources/${file}`,
    ),
    ...directJsonEntries(directories.definitions).map(
      (file) => `definitions/${file}`,
    ),
  ];
  if (existing.length > 0) {
    throw new Error(
      `cannot establish artifact ownership for non-empty output ${outDir}: ${existing.join(', ')}`,
    );
  }
  return null;
}

function assertOwnedFileShape(
  directory: string,
  fileName: string,
  relativePath: string,
): void {
  const path = join(directory, fileName);
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`owned artifact is not a regular file: ${relativePath}`);
  }
}

function assertNoUnownedCollisions(
  directory: string,
  targetFiles: readonly string[],
  previouslyOwned: ReadonlySet<string>,
  kind: 'resources' | 'definitions',
): void {
  for (const fileName of targetFiles) {
    if (
      existsSync(join(directory, fileName)) &&
      !previouslyOwned.has(fileName)
    ) {
      throw new Error(`unowned target collision: ${kind}/${fileName}`);
    }
  }
}

export function writeSchemaArtifacts(
  snapshot: SchemaArtifactSnapshot,
  outDir: string,
): SchemaArtifactWriteResult {
  const source = SchemaIngestionSourceSchema.parse(snapshot.source);
  const resources = sortedEntries(snapshot.resources, 'resource');
  const definitions = sortedEntries(snapshot.definitions, 'definition');
  const directories = artifactDirectories(outDir);
  const previous = previousManifest(outDir, directories);
  mkdirSync(directories.resources, { recursive: true });
  mkdirSync(directories.definitions, { recursive: true });

  const previousResources = new Set(previous?.ownedFiles.resources ?? []);
  const previousDefinitions = new Set(previous?.ownedFiles.definitions ?? []);
  const resourceFiles = resources.map(([fileName]) => fileName);
  const definitionFiles = definitions.map(([fileName]) => fileName);

  for (const fileName of previousResources) {
    assertOwnedFileShape(
      directories.resources,
      fileName,
      `resources/${fileName}`,
    );
  }
  for (const fileName of previousDefinitions) {
    assertOwnedFileShape(
      directories.definitions,
      fileName,
      `definitions/${fileName}`,
    );
  }
  assertNoUnownedCollisions(
    directories.resources,
    resourceFiles,
    previousResources,
    'resources',
  );
  assertNoUnownedCollisions(
    directories.definitions,
    definitionFiles,
    previousDefinitions,
    'definitions',
  );

  for (const [fileName, value] of resources) {
    writeJsonAtomic(join(directories.resources, fileName), value);
  }
  for (const [fileName, value] of definitions) {
    writeJsonAtomic(join(directories.definitions, fileName), value);
  }

  const currentResources = new Set(resourceFiles);
  const currentDefinitions = new Set(definitionFiles);
  const removedFiles = [
    ...[...previousResources]
      .filter((fileName) => !currentResources.has(fileName))
      .map((fileName) => `resources/${fileName}`),
    ...[...previousDefinitions]
      .filter((fileName) => !currentDefinitions.has(fileName))
      .map((fileName) => `definitions/${fileName}`),
  ].sort();
  for (const relativePath of removedFiles) {
    rmSync(join(outDir, relativePath), { force: true });
  }

  const manifest = SchemaArtifactManifestSchema.parse({
    formatVersion: SCHEMA_ARTIFACT_MANIFEST_VERSION,
    owner: 'ingest-schemas',
    source,
    generatedAt: new Date().toISOString(),
    layout: 'resources+definitions',
    ownedFiles: {
      resources: resourceFiles,
      definitions: definitionFiles,
    },
  });
  writeJsonAtomic(join(outDir, 'manifest.json'), manifest);
  return { manifest, removedFiles };
}
