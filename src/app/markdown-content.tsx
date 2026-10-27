"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <div className="markdown-content">
    <ReactMarkdown remarkPlugins={plugins} components={{
      a: ({ href, children, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
      table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>,
    }}>{children}</ReactMarkdown>
  </div>;
});
