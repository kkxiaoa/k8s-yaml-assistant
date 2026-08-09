import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeChunk } from '../knowledge/chunk';
import { retrievalDocumentText } from './document-text';

const schemaChunk: KnowledgeChunk = {
  id: 'schema::v1::ResourceQuota::spec.hard',
  title: 'ResourceQuota · spec.hard',
  text: 'schema body',
  sourceType: 'schema',
  provenance: { authority: 'cluster_api', version: 'v1' },
  targets: [{ apiVersion: 'v1', kind: 'ResourceQuota', path: 'spec.hard' }],
};

const docsChunk: KnowledgeChunk = {
  id: 'docs::kubernetes::resource-quotas::compute-resource-quota',
  title: 'ResourceQuota · spec.hard · 基础设施资源配额',
  text: '用户可以对给定命名空间下可被请求的计算资源总量进行限制。',
  sourceType: 'docs',
  provenance: {
    authority: 'kubernetes_official',
    sourceUri:
      'https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/#compute-resource-quota',
    version: 'a'.repeat(40),
  },
  targets: [{ apiVersion: 'v1', kind: 'ResourceQuota', path: 'spec.hard' }],
};

test('非 docs 来源保持既有正文输入，按需补标题', () => {
  assert.equal(retrievalDocumentText(schemaChunk), schemaChunk.text);
  assert.equal(
    retrievalDocumentText(schemaChunk, true),
    `${schemaChunk.title}\n${schemaChunk.text}`,
  );
});

test('docs 来源统一补标题和规范目标且不重复标题', () => {
  const expected = `${docsChunk.title}\n规范目标: apiVersion=v1, kind=ResourceQuota, path=spec.hard\n${docsChunk.text}`;
  assert.equal(retrievalDocumentText(docsChunk), expected);
  assert.equal(retrievalDocumentText(docsChunk, true), expected);
});
