import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'K8s YAML 智能助手',
  description: 'RAG 问答 + 校验 + 生成,基于检索增强',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
