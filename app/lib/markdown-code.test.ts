import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  markdownCodeLanguage,
  markdownContainsFencedCode,
  markdownRepeatsFencedCode,
  writeCodeToClipboard,
} from './markdown-code';

test('只在回答围栏完整复现来源围栏时判定重复', () => {
  const source = '```yaml\r\nkind: Pod  \r\nmetadata:\r\n  name: demo\r\n```';
  const answer =
    '参考示例：\n\n```yaml\nkind: Pod\nmetadata:\n  name: demo\n```\n\n以上。';

  assert.equal(markdownRepeatsFencedCode(answer, source), true);
  assert.equal(
    markdownContainsFencedCode(
      source,
      'kind: Pod\nmetadata:\n  name: demo\n',
    ),
    true,
  );
  assert.equal(
    markdownRepeatsFencedCode(
      '```yaml\nkind: Pod\nmetadata:\n  name: another\n```',
      source,
    ),
    false,
  );
  assert.equal(
    markdownRepeatsFencedCode(
      'kind: Pod\nmetadata:\n  name: demo',
      source,
    ),
    false,
  );
});

test('YAML 围栏生成语言标签和安全语法标记', () => {
  const result = markdownCodeLanguage(
    'apiVersion: v1\nmetadata:\n  name: "<script>"\n',
    'language-yaml extra',
  );

  assert.equal(result.id, 'yaml');
  assert.equal(result.label, 'YAML');
  assert.match(result.highlightedHtml ?? '', /hljs-attr/u);
  assert.match(result.highlightedHtml ?? '', /hljs-string/u);
  assert.doesNotMatch(result.highlightedHtml ?? '', /<script>/u);
  assert.match(result.highlightedHtml ?? '', /&lt;script&gt;/u);
});

test('yml 使用 YAML 高亮，未知或缺失语言安全退化为纯文本', () => {
  assert.equal(markdownCodeLanguage('kind: Pod', 'language-yml').id, 'yaml');
  assert.deepEqual(markdownCodeLanguage('echo ok', 'language-shell'), {
    id: 'shell',
    label: 'SHELL',
    highlightedHtml: null,
  });
  assert.deepEqual(markdownCodeLanguage('plain text'), {
    id: null,
    label: 'TEXT',
    highlightedHtml: null,
  });
});

test('复制使用原始代码并封闭处理不可用或失败的剪贴板', async () => {
  let copied = '';
  assert.equal(
    await writeCodeToClipboard(
      {
        async writeText(value) {
          copied = value;
        },
      },
      'kind: Pod\n',
    ),
    true,
  );
  assert.equal(copied, 'kind: Pod\n');
  assert.equal(await writeCodeToClipboard(undefined, 'kind: Pod'), false);
  assert.equal(
    await writeCodeToClipboard(
      {
        async writeText() {
          throw new Error('denied');
        },
      },
      'kind: Pod',
    ),
    false,
  );
});
