'use client';

import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

export function MarkdownText({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none break-words prose-p:my-1 prose-headings:mt-3 prose-headings:mb-1 prose-li:my-0.5 prose-hr:my-2 prose-pre:my-1 prose-pre:overflow-x-auto prose-code:break-words ${className}`}>
      <Markdown remarkPlugins={[remarkBreaks]}>{children}</Markdown>
    </div>
  );
}
