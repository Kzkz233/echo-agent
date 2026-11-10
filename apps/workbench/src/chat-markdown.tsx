import { t } from './i18n.ts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export default function ChatMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        img: ({ alt, src }) => (
          <a href={src} target="_blank" rel="noopener noreferrer">
            {alt || t('查看图片')}
          </a>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
