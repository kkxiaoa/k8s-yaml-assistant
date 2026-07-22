import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'k8s.assistant — schema 驱动的 K8s 配置助手',
  description: 'RAG 问答 + schema 驱动校验,活在编辑器里',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
