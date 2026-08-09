import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  canonicalizeKnowledgeTargets,
  KnowledgeTargetSchema,
  type Chunk,
} from './chunk';

const DOCS_ROOT = join(
  process.cwd(),
  'data',
  'knowledge',
  'kubernetes-docs',
);

const NonEmptyTrimmedStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must be trimmed');
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const DirectMarkdownFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u);
const UpstreamMarkdownPathSchema = z
  .string()
  .regex(/^content\/zh-cn\/docs\/[A-Za-z0-9_./-]+\.md$/u)
  .refine((value) => !value.split('/').includes('..'), 'must not traverse');
const StableIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const AnchorSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const KubernetesDocsPageUriSchema = z
  .url({ protocol: /^https$/u })
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === 'https://kubernetes.io' &&
      url.pathname.startsWith('/zh-cn/docs/') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  }, 'must be a canonical Kubernetes simplified Chinese docs page without query or fragment');

const DocsSectionSchema = z.strictObject({
  id: StableIdSchema,
  heading: NonEmptyTrimmedStringSchema,
  anchor: AnchorSchema,
  title: NonEmptyTrimmedStringSchema,
  targets: z
    .array(KnowledgeTargetSchema)
    .min(1)
    .transform(canonicalizeKnowledgeTargets),
});

const DocsDocumentSchema = z.strictObject({
  id: StableIdSchema,
  snapshot: DirectMarkdownFileSchema,
  upstreamPath: UpstreamMarkdownPathSchema,
  upstreamBlobSha1: GitObjectIdSchema,
  sourceUri: KubernetesDocsPageUriSchema,
  sections: z.array(DocsSectionSchema).min(1),
});

const KubernetesDocsManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    providerId: z.literal('docs.kubernetes-official'),
    sourceType: z.literal('docs'),
    version: GitObjectIdSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    upstreamRepository: z.literal('https://github.com/kubernetes/website'),
    license: z.strictObject({
      spdxId: z.literal('CC-BY-4.0'),
      sourceUri: z.url({ protocol: /^https$/u }),
    }),
    documents: z.array(DocsDocumentSchema).min(1),
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
    const documentIds = new Set<string>();
    const snapshots = new Set<string>();
    for (const [documentIndex, document] of manifest.documents.entries()) {
      if (documentIds.has(document.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate document id: ${document.id}`,
          path: ['documents', documentIndex, 'id'],
        });
      }
      documentIds.add(document.id);
      if (snapshots.has(document.snapshot)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate snapshot: ${document.snapshot}`,
          path: ['documents', documentIndex, 'snapshot'],
        });
      }
      snapshots.add(document.snapshot);

      const sectionIds = new Set<string>();
      const anchors = new Set<string>();
      for (const [sectionIndex, section] of document.sections.entries()) {
        if (sectionIds.has(section.id)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate section id: ${section.id}`,
            path: ['documents', documentIndex, 'sections', sectionIndex, 'id'],
          });
        }
        sectionIds.add(section.id);
        if (anchors.has(section.anchor)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate section anchor: ${section.anchor}`,
            path: [
              'documents',
              documentIndex,
              'sections',
              sectionIndex,
              'anchor',
            ],
          });
        }
        anchors.add(section.anchor);
      }
    }
  });

type KubernetesDocsManifest = z.infer<typeof KubernetesDocsManifestSchema>;
type DocsDocument = z.infer<typeof DocsDocumentSchema>;
type DocsSection = z.infer<typeof DocsSectionSchema>;

interface KubernetesDocsProviderSnapshot {
  providerId: 'docs.kubernetes-official';
  version: string;
  generatedAt: string;
  chunks: Chunk[];
}

interface MarkdownHeading {
  level: number;
  title: string;
  anchor?: string;
  line: number;
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
}

interface MarkdownFenceDelimiter extends MarkdownFence {
  suffix: string;
}

function gitBlobSha1(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function parseFenceDelimiter(line: string): MarkdownFenceDelimiter | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  return {
    marker: match[1]![0] as '`' | '~',
    length: match[1]!.length,
    suffix: match[2]!,
  };
}

function closesFence(
  fence: MarkdownFence,
  delimiter: MarkdownFenceDelimiter,
): boolean {
  return (
    delimiter.marker === fence.marker &&
    delimiter.length >= fence.length &&
    delimiter.suffix.trim().length === 0
  );
}

function parseHeading(line: string, lineNumber: number): MarkdownHeading | null {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line);
  if (!match) return null;
  const headingText = match[2]!.replace(/[ \t]+#+[ \t]*$/u, '').trimEnd();
  const anchorMatch = /[ \t]+\{#([a-z0-9]+(?:-[a-z0-9]+)*)\}$/u.exec(
    headingText,
  );
  const title = anchorMatch
    ? headingText.slice(0, anchorMatch.index).trimEnd()
    : headingText;
  return {
    level: match[1]!.length,
    title,
    ...(anchorMatch === null ? {} : { anchor: anchorMatch[1] }),
    line: lineNumber,
  };
}

function markdownHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: MarkdownFence | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = parseFenceDelimiter(line);
    if (delimiter) {
      if (fence === undefined) {
        fence = { marker: delimiter.marker, length: delimiter.length };
      } else if (closesFence(fence, delimiter)) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    const heading = parseHeading(line, index);
    if (heading) headings.push(heading);
  }
  return headings;
}

function normalizeSectionMarkdown(markdown: string): string {
  const normalized: string[] = [];
  let fence: MarkdownFence | undefined;
  let previousBlank = false;

  for (const line of markdown.split('\n')) {
    const delimiter = parseFenceDelimiter(line);
    if (delimiter) {
      normalized.push(line);
      if (fence === undefined) {
        fence = { marker: delimiter.marker, length: delimiter.length };
      } else if (closesFence(fence, delimiter)) {
        fence = undefined;
      }
      previousBlank = false;
      continue;
    }

    if (fence !== undefined) {
      normalized.push(line);
      continue;
    }

    const visibleLine = line.replace(
      /\]\((\/(?:zh-cn\/)?docs\/[^)\s]+)\)/gu,
      (_match, path: string) => `](https://kubernetes.io${path})`,
    );
    const blank = visibleLine.trim().length === 0;
    if (blank && previousBlank) continue;
    normalized.push(visibleLine);
    previousBlank = blank;
  }

  return normalized.join('\n');
}

function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end).join('\n');
}

function extractSection(
  markdown: string,
  document: DocsDocument,
  section: DocsSection,
): string {
  const visibleMarkdown = markdown.replace(/<!--[\s\S]*?-->/gu, '');
  const lines = visibleMarkdown.split(/\r?\n/u);
  const headings = markdownHeadings(lines);
  const matches = headings.filter(
    (heading) =>
      heading.title === section.heading && heading.anchor === section.anchor,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${document.id} section ${section.id} expected one heading ${section.heading} {#${section.anchor}}, found ${matches.length}`,
    );
  }
  const selected = matches[0]!;
  const next = headings.find(
    (heading) =>
      heading.line > selected.line && heading.level <= selected.level,
  );
  const text = normalizeSectionMarkdown(
    trimBlankLines(lines.slice(selected.line + 1, next?.line ?? lines.length)),
  );
  if (text.length === 0) {
    throw new Error(`${document.id} section ${section.id} is empty`);
  }
  return text;
}

function readSnapshot(root: string, document: DocsDocument): string {
  const path = join(root, document.snapshot);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${document.snapshot} must be a regular file`);
  }
  const content = readFileSync(path);
  const actualBlobSha1 = gitBlobSha1(content);
  if (actualBlobSha1 !== document.upstreamBlobSha1) {
    throw new Error(
      `${document.snapshot} (${document.upstreamPath}) Git blob mismatch: expected ${document.upstreamBlobSha1}, got ${actualBlobSha1}`,
    );
  }
  return content.toString('utf8');
}

function docsChunkId(
  document: DocsDocument,
  section: DocsSection,
): string {
  return `docs::kubernetes::${document.id}::${section.id}`;
}

function buildDocumentChunks(params: {
  manifest: KubernetesDocsManifest;
  document: DocsDocument;
  markdown: string;
}): Chunk[] {
  const { manifest, document, markdown } = params;
  return document.sections.map((section) => ({
    id: docsChunkId(document, section),
    title: section.title,
    text: extractSection(markdown, document, section),
    sourceType: 'docs',
    provenance: {
      authority: 'kubernetes_official',
      sourceUri: `${document.sourceUri}#${section.anchor}`,
      version: manifest.version,
    },
    targets: section.targets,
  }));
}

export function loadKubernetesDocsProviderSnapshot(
  root = DOCS_ROOT,
): KubernetesDocsProviderSnapshot {
  const manifestPath = join(root, 'manifest.json');
  const manifest = KubernetesDocsManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  const chunks = manifest.documents.flatMap((document) =>
    buildDocumentChunks({
      manifest,
      document,
      markdown: readSnapshot(root, document),
    }),
  );
  return {
    providerId: manifest.providerId,
    version: manifest.version,
    generatedAt: manifest.capturedAt,
    chunks,
  };
}
