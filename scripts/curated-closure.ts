// 计算 curated 白名单资源入口及其 $ref 递归依赖 definitions 的传递闭包。
// 只有这部分需要进 git(自包含、可复现、体积小);全量 generated/ 其余部分继续 gitignore。
// 用法:
//   npm run corpus:closure            打印闭包统计(资源数 / definition 数 / 体积)
//   npm run corpus:closure -- --list  仅逐行输出闭包文件相对路径,供 `git add -f` 消费
//
// 维护:往 curated.json 加资源后重跑,用 --list 的输出同步 git 跟踪范围。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import curated from '../data/schemas/curated.json';

interface CuratedEntry {
  kind: string;
  apiVersion: string;
}

const ROOT = process.cwd();
const GENERATED_DIR = join(ROOT, 'data', 'schemas', 'generated');
const RESOURCES_DIR = join(GENERATED_DIR, 'resources');
const DEFINITIONS_DIR = join(GENERATED_DIR, 'definitions');
const REF_PREFIX = '#/components/schemas/';

function resourceFileNameOf(entry: CuratedEntry): string {
  const [group, version] = entry.apiVersion.includes('/')
    ? (entry.apiVersion.split('/') as [string, string])
    : ['core', entry.apiVersion];
  return `${group}.${version}.${entry.kind}.json`;
}

// 深扫任意节点,收集所有 `#/components/schemas/<name>` 引用的 definition 名。
function collectRefs(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
        acc.add(value.slice(REF_PREFIX.length));
      } else {
        collectRefs(value, acc);
      }
    }
  }
}

function main(): void {
  const listOnly = process.argv.includes('--list');
  if (!existsSync(RESOURCES_DIR) || !existsSync(DEFINITIONS_DIR)) {
    throw new Error(`缺少 ${RESOURCES_DIR} 或 ${DEFINITIONS_DIR}。请先运行 npm run ingest:schemas。`);
  }

  const entries = [
    ...(curated.builtin as CuratedEntry[]),
    ...(curated.crd as CuratedEntry[]),
  ];

  // 1. 资源入口文件
  const resourceFiles: string[] = [];
  const pending = new Set<string>(); // 待展开的 definition 名
  const missingResources: string[] = [];
  for (const entry of entries) {
    const file = join(RESOURCES_DIR, resourceFileNameOf(entry));
    if (!existsSync(file)) {
      missingResources.push(`${entry.apiVersion}/${entry.kind}`);
      continue;
    }
    resourceFiles.push(file);
    collectRefs(JSON.parse(readFileSync(file, 'utf8')), pending);
  }
  if (missingResources.length > 0) {
    throw new Error(`curated 白名单存在 generated 缺失资源: ${missingResources.join(', ')}`);
  }

  // 2. definition 传递闭包(BFS)
  const closure = new Set<string>();
  const missingDefs = new Set<string>();
  const queue = [...pending];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name) || missingDefs.has(name)) continue;
    const file = join(DEFINITIONS_DIR, `${name}.json`);
    if (!existsSync(file)) {
      missingDefs.add(name);
      continue;
    }
    closure.add(name);
    const refs = new Set<string>();
    collectRefs(JSON.parse(readFileSync(file, 'utf8')), refs);
    for (const r of refs) if (!closure.has(r)) queue.push(r);
  }

  const definitionFiles = [...closure]
    .sort()
    .map((name) => join(DEFINITIONS_DIR, `${name}.json`));
  const allFiles = [...resourceFiles.sort(), ...definitionFiles];

  if (listOnly) {
    for (const f of allFiles) console.log(relative(ROOT, f));
    return;
  }

  const totalBytes = allFiles.reduce((sum, f) => sum + statSync(f).size, 0);
  console.log('=== curated 白名单闭包 ===');
  console.log(`资源入口 (resources)   : ${resourceFiles.length}`);
  console.log(`依赖定义 (definitions) : ${closure.size}`);
  console.log(`闭包文件总数           : ${allFiles.length}`);
  console.log(`闭包体积               : ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (missingDefs.size > 0) {
    console.log(`\n⚠ 悬空 $ref(definition 缺失,已跳过): ${missingDefs.size}`);
    console.log([...missingDefs].sort().slice(0, 20).join(', '));
  }
}

main();
