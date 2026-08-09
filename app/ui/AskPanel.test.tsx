import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceHit } from '../lib/api';
import { AskPanel } from './AskPanel';

function source(
  n: number,
  sourceType: SourceHit['sourceType'],
  text: string,
): SourceHit {
  return {
    n,
    id: `${sourceType}-${n}`,
    title: `${sourceType} source ${n}`,
    text,
    sourceType,
    provenance: {
      authority:
        sourceType === 'example' ? 'kubernetes_official' : 'cluster_api',
      sourceUri: `https://example.com/source-${n}`,
    },
    targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'metadata.name' }],
  };
}

function render(answer: string, sources: SourceHit[]): string {
  return renderToStaticMarkup(
    <AskPanel
      question="如何配置？"
      answer={answer}
      sources={sources}
      feedbackRequestId={null}
      asking={false}
      disabled={false}
      loginRequired={false}
      canExplainField={false}
      canExplainError={false}
      onChange={() => undefined}
      onAsk={() => undefined}
    />,
  );
}

test('正文完整复现官方示例时把来源移到围栏并重排可见引用', () => {
  const yaml = 'kind: Pod\nmetadata:\n  name: demo';
  const html = render(
    `字段事实 [S1]。参考 [S2]：\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n补充说明 [S3]。`,
    [
      source(1, 'docs', '字段事实。'),
      source(2, 'example', `\`\`\`yaml\n${yaml}\n\`\`\``),
      source(3, 'schema', '补充说明。'),
    ],
  );

  assert.match(html, /Kubernetes 官方示例 ↗/u);
  assert.match(html, /参考：/u);
  assert.match(html, /\[S1\]/u);
  assert.match(html, /\[S2\]/u);
  assert.doesNotMatch(html, /\[S3\]/u);
  assert.doesNotMatch(html, /查看来源示例/u);
  assert.doesNotMatch(html, /查看官方来源/u);
});

test('正文没有复现官方示例时保留可展开来源卡片', () => {
  const html = render(
    '参考来源 [S1]：\n\n```yaml\nkind: Pod\nmetadata:\n  name: changed\n```',
    [
      source(
        1,
        'example',
        '```yaml\nkind: Pod\nmetadata:\n  name: original\n```',
      ),
    ],
  );

  assert.match(html, /查看来源示例/u);
  assert.match(html, /查看官方来源/u);
  assert.doesNotMatch(html, /Kubernetes 官方示例 ↗/u);
});
