import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
});

export const metadata: Metadata = {
  title: 'k8s.assistant — schema 驱动的 K8s 配置助手',
  description: 'RAG 问答 + schema 驱动校验,活在编辑器里',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" className={`${mono.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
