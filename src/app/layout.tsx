import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Recall · 动态记忆 RAG", description: "可追溯的动态记忆与两轮检索实验室" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
