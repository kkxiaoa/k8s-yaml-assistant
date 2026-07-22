import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 开发构建和独立产物追踪必须保持同一个仓库边界，不能受父目录锁文件影响。
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
  output: 'standalone',
};

export default nextConfig;
