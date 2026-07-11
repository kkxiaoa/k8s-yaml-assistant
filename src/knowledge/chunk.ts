export type SourceType = 'schema' | 'policy' | 'docs' | 'example';

export type TrustLevel =
  | 'k8s-official'
  | 'org-policy'
  | 'k8s-docs'
  | 'example';

export interface ChunkAppliesTo {
  resource: string;
  field?: string;
}

export interface KnowledgeChunk {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  sourceUri?: string;
  version?: string;
  trustLevel?: TrustLevel;
  resource?: string;
  path?: string;
  resources?: string[];
  paths?: string[];
  appliesTo?: ChunkAppliesTo | ChunkAppliesTo[];
}

export type Chunk = KnowledgeChunk;

export type ChunkLocator = Pick<
  KnowledgeChunk,
  'resource' | 'path' | 'resources' | 'paths' | 'appliesTo'
>;

function compact(values: Array<string | undefined>): string[] {
  return values.filter((v): v is string => Boolean(v));
}

function appliesToList(chunk: ChunkLocator): ChunkAppliesTo[] {
  if (!chunk.appliesTo) return [];
  return Array.isArray(chunk.appliesTo) ? chunk.appliesTo : [chunk.appliesTo];
}

export function chunkResources(chunk: ChunkLocator): string[] {
  if (chunk.resources?.length) return chunk.resources;
  const fromAppliesTo = compact(appliesToList(chunk).map((item) => item.resource));
  if (fromAppliesTo.length) return fromAppliesTo;
  return compact([chunk.resource]);
}

export function chunkPaths(chunk: ChunkLocator): string[] {
  if (chunk.paths?.length) return chunk.paths;
  const fromAppliesTo = compact(appliesToList(chunk).map((item) => item.field));
  if (fromAppliesTo.length) return fromAppliesTo;
  return compact([chunk.path]);
}

export function primaryResource(chunk: ChunkLocator): string | undefined {
  return chunkResources(chunk)[0];
}

export function primaryPath(chunk: ChunkLocator): string | undefined {
  return chunkPaths(chunk)[0];
}
