import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLICATION_BASE_PATH,
  rootHealthRedirects,
} from './src/shared/application-path.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 开发构建和独立产物追踪必须保持同一个仓库边界，不能受父目录锁文件影响。
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
  output: 'standalone',
  basePath: APPLICATION_BASE_PATH,
  redirects: rootHealthRedirects,
};

export default nextConfig;
