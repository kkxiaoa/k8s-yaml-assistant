import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 本项目当前嵌套在 acp-plugin(Yarn 仓库)里,Next 会向上发现 acp-plugin/yarn.lock
  // 把工作区根误判成 acp-plugin。这里钉死根为本项目目录(turbopack dev + build 文件追踪)。
  // 将来把项目移出 acp-plugin 后,这两行依然无害。
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
