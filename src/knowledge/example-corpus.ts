import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { z } from 'zod';
import {
  canonicalizeKnowledgeTargets,
  KnowledgeTargetSchema,
  type Chunk,
  type KnowledgeTarget,
} from './chunk';
import { readVerifiedProviderSnapshot } from './provider-snapshot';

const EXAMPLES_ROOT = join(
  process.cwd(),
  'data',
  'knowledge',
  'kubernetes-examples',
);

const NonEmptyTrimmedStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must be trimmed');
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const StableIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const DirectYamlFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u);
const UpstreamYamlPathSchema = z
  .string()
  .regex(/^content\/zh-cn\/examples\/[A-Za-z0-9_./-]+\.ya?ml$/u)
  .refine((value) => !value.split('/').includes('..'), 'must not traverse');

const ExampleSchema = z
  .strictObject({
    id: StableIdSchema,
    snapshot: DirectYamlFileSchema,
    upstreamPath: UpstreamYamlPathSchema,
    upstreamBlobSha1: GitObjectIdSchema,
    title: NonEmptyTrimmedStringSchema,
    targets: z
      .array(KnowledgeTargetSchema)
      .min(1)
      .transform(canonicalizeKnowledgeTargets),
  })
  .superRefine((example, context) => {
    for (const [index, target] of example.targets.entries()) {
      if (target.apiVersion === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'example target requires apiVersion',
          path: ['targets', index, 'apiVersion'],
        });
      }
      if (target.path === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'example target requires path',
          path: ['targets', index, 'path'],
        });
      }
    }
  });

const KubernetesExamplesManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    providerId: z.literal('example.kubernetes-official'),
    sourceType: z.literal('example'),
    version: GitObjectIdSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    upstreamRepository: z.literal('https://github.com/kubernetes/website'),
    license: z.strictObject({
      spdxId: z.literal('CC-BY-4.0'),
      sourceUri: z.url({ protocol: /^https$/u }),
    }),
    examples: z.array(ExampleSchema).min(1),
  })
  .superRefine((manifest, context) => {
    const expectedLicenseUri = `${manifest.upstreamRepository}/blob/${manifest.version}/LICENSE`;
    if (manifest.license.sourceUri !== expectedLicenseUri) {
      context.addIssue({
        code: 'custom',
        message: `license sourceUri must pin provider version: ${expectedLicenseUri}`,
        path: ['license', 'sourceUri'],
      });
    }

    const ids = new Set<string>();
    const snapshots = new Set<string>();
    const upstreamPaths = new Set<string>();
    for (const [index, example] of manifest.examples.entries()) {
      for (const [value, seen, path] of [
        [example.id, ids, 'id'],
        [example.snapshot, snapshots, 'snapshot'],
        [example.upstreamPath, upstreamPaths, 'upstreamPath'],
      ] as const) {
        if (seen.has(value)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate example ${path}: ${value}`,
            path: ['examples', index, path],
          });
        }
        seen.add(value);
      }
    }
  });

type KubernetesExamplesManifest = z.infer<
  typeof KubernetesExamplesManifestSchema
>;
type Example = z.infer<typeof ExampleSchema>;

interface KubernetesExamplesProviderSnapshot {
  providerId: 'example.kubernetes-official';
  version: string;
  generatedAt: string;
  chunks: Chunk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesAtPath(value: unknown, segments: readonly string[]): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => valuesAtPath(item, segments));
  }
  if (segments.length === 0) {
    return value === undefined || value === null ? [] : [value];
  }
  if (!isRecord(value)) return [];
  const [head, ...tail] = segments;
  if (head === undefined || !Object.hasOwn(value, head)) return [];
  return valuesAtPath(value[head], tail);
}

function parseSingleKubernetesResource(
  yaml: string,
  example: Example,
): void {
  let documents: unknown[];
  try {
    documents = loadAll(yaml).filter((document) => document != null);
  } catch (error) {
    throw new Error(
      `${example.id} YAML parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (documents.length !== 1 || !isRecord(documents[0])) {
    throw new Error(`${example.id} must contain exactly one resource object`);
  }

  const resource = documents[0];
  const apiVersions = new Set(
    example.targets.map((target) => target.apiVersion),
  );
  const kinds = new Set(example.targets.map((target) => target.kind));
  if (
    apiVersions.size !== 1 ||
    !apiVersions.has(
      typeof resource.apiVersion === 'string'
        ? resource.apiVersion
        : undefined,
    ) ||
    kinds.size !== 1 ||
    !kinds.has(typeof resource.kind === 'string' ? resource.kind : '')
  ) {
    throw new Error(`${example.id} resource identity differs from targets`);
  }

  const metadata = isRecord(resource.metadata) ? resource.metadata : undefined;
  if (
    metadata === undefined ||
    typeof metadata.name !== 'string' ||
    metadata.name.trim().length === 0
  ) {
    throw new Error(`${example.id} requires metadata.name`);
  }

  for (const target of example.targets as KnowledgeTarget[]) {
    const path = target.path;
    if (
      path === undefined ||
      valuesAtPath(resource, path.split('.')).length === 0
    ) {
      throw new Error(`${example.id} target path missing: ${String(path)}`);
    }
  }
}

function exampleChunk(
  manifest: KubernetesExamplesManifest,
  example: Example,
  content: Buffer,
): Chunk {
  const yaml = content.toString('utf8');
  parseSingleKubernetesResource(yaml, example);
  return {
    id: `example::kubernetes::${example.id}`,
    title: example.title,
    text: `\`\`\`yaml\n${yaml.trimEnd()}\n\`\`\``,
    sourceType: 'example',
    provenance: {
      authority: 'kubernetes_official',
      sourceUri: `${manifest.upstreamRepository}/blob/${manifest.version}/${example.upstreamPath}`,
      version: manifest.version,
    },
    targets: example.targets,
  };
}

export function loadKubernetesExamplesProviderSnapshot(
  root = EXAMPLES_ROOT,
): KubernetesExamplesProviderSnapshot {
  const manifest = KubernetesExamplesManifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as unknown,
  );
  const chunks = manifest.examples.map((example) =>
    exampleChunk(
      manifest,
      example,
      readVerifiedProviderSnapshot({
        root,
        snapshot: example.snapshot,
        upstreamPath: example.upstreamPath,
        upstreamBlobSha1: example.upstreamBlobSha1,
      }),
    ),
  );
  return {
    providerId: manifest.providerId,
    version: manifest.version,
    generatedAt: manifest.capturedAt,
    chunks,
  };
}
