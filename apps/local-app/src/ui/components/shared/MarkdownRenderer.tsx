/**
 * MarkdownRenderer component
 *
 * Renders markdown content to safe HTML. Supports headings, bold, italic,
 * links, code blocks, lists, and paragraphs.
 *
 * SECURITY: Output is sanitized with DOMPurify to prevent XSS attacks.
 */

import DOMPurify from 'dompurify';
import { cn } from '@/ui/lib/utils';

export interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
}

/**
 * Convert heading text to a URL-safe slug
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Escape HTML entities to prevent raw HTML injection
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Apply inline markdown transformations (bold, italic, links, inline code)
 */
function parseInline(text: string): string {
  return (
    text
      // Inline code (before bold/italic to prevent conflicts)
      .replace(
        /`([^`]+)`/g,
        '<code class="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">$1</code>',
      )
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Links - only allow safe URL schemes
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
        const safeUrl = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
        return `<a href="${safeUrl}" class="text-primary underline hover:text-primary/80" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
      })
  );
}

/**
 * Parse a single list (unordered or ordered)
 */
function parseList(lines: string[], startIndex: number, isOrdered: boolean): [string, number] {
  const items: string[] = [];
  const pattern = isOrdered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
  let i = startIndex;

  while (i < lines.length) {
    const match = lines[i].match(pattern);
    if (!match) break;
    items.push(`<li>${parseInline(escapeHtml(match[1]))}</li>`);
    i++;
  }

  const tag = isOrdered ? 'ol' : 'ul';
  const className = isOrdered ? 'list-decimal' : 'list-disc';
  return [`<${tag} class="${className} pl-6 my-2 space-y-1 text-muted-foreground">${items.join('')}</${tag}>`, i];
}

/**
 * Parse markdown code block
 */
function parseCodeBlock(lines: string[], startIndex: number): [string, number] {
  const firstLine = lines[startIndex];
  const langMatch = firstLine.match(/^```(\w*)$/);
  const language = langMatch?.[1] || '';

  let i = startIndex + 1;
  const codeLines: string[] = [];

  while (i < lines.length && !lines[i].startsWith('```')) {
    codeLines.push(lines[i]);
    i++;
  }

  // Skip closing ```
  if (i < lines.length && lines[i].startsWith('```')) {
    i++;
  }

  const code = escapeHtml(codeLines.join('\n'));
  const langAttr = language ? ` data-language="${language}"` : '';
  return [
    `<pre class="bg-muted p-4 rounded-md text-sm overflow-x-auto my-4"${langAttr}><code class="font-mono">${code}</code></pre>`,
    i,
  ];
}

/**
 * Render markdown content to HTML
 *
 * Parses block elements first (headings, code blocks, lists, paragraphs),
 * then applies inline transformations within each block.
 */
export function renderMarkdown(content: string): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line - skip
    if (!line.trim()) {
      i++;
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const [html, nextIndex] = parseCodeBlock(lines, i);
      output.push(html);
      i = nextIndex;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      output.push('<hr class="my-6 border-border" />');
      i++;
      continue;
    }

    // Headings
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      const text = h3Match[1];
      const id = slugify(text);
      output.push(
        `<h3 id="${id}" class="text-base font-semibold mt-8 mb-2 border-l-2 border-primary/40 pl-2">${parseInline(escapeHtml(text))}</h3>`,
      );
      i++;
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      const text = h2Match[1];
      const id = slugify(text);
      output.push(
        `<h2 id="${id}" class="text-xl font-semibold mt-8 mb-3 pb-2 border-b border-border">${parseInline(escapeHtml(text))}</h2>`,
      );
      i++;
      continue;
    }

    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      const text = h1Match[1];
      const id = slugify(text);
      output.push(
        `<h1 id="${id}" class="text-2xl font-bold mt-8 mb-4">${parseInline(escapeHtml(text))}</h1>`,
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const quoteText = quoteLines.join(' ');
      output.push(
        `<blockquote class="my-4 border-l-4 border-primary/40 bg-muted/50 rounded-r-md py-3 px-4 text-sm leading-relaxed">${parseInline(escapeHtml(quoteText))}</blockquote>`,
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const [html, nextIndex] = parseList(lines, i, false);
      output.push(html);
      i = nextIndex;
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const [html, nextIndex] = parseList(lines, i, true);
      output.push(html);
      i = nextIndex;
      continue;
    }

    // Table row (basic support - render as-is in a code-like block)
    if (line.startsWith('|') && line.endsWith('|')) {
      // Collect all table rows
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('|') && lines[i].endsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      // Render as preformatted text for now (full table support is out of scope)
      output.push(
        `<pre class="bg-muted p-2 rounded text-sm overflow-x-auto my-2 font-mono">${escapeHtml(tableLines.join('\n'))}</pre>`,
      );
      continue;
    }

    // Paragraph - collect consecutive non-empty, non-block lines
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !(lines[i].startsWith('|') && lines[i].endsWith('|'))
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }

    if (paragraphLines.length > 0) {
      const text = paragraphLines.join(' ');
      output.push(`<p class="my-3 leading-relaxed text-muted-foreground">${parseInline(escapeHtml(text))}</p>`);
    }
  }

  // SECURITY: Sanitize the final HTML with DOMPurify
  return DOMPurify.sanitize(output.join('\n'), {
    ALLOWED_TAGS: [
      'h1',
      'h2',
      'h3',
      'p',
      'pre',
      'code',
      'strong',
      'em',
      'a',
      'ul',
      'ol',
      'li',
      'br',
      'hr',
      'blockquote',
    ],
    ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'id', 'data-language'],
    ALLOW_DATA_ATTR: true,
  });
}

/**
 * Extract headings from markdown content for TOC generation
 */
export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      headings.push({ id: slugify(h1Match[1]), text: h1Match[1], level: 1 });
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      headings.push({ id: slugify(h2Match[1]), text: h2Match[1], level: 2 });
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      headings.push({ id: slugify(h3Match[1]), text: h3Match[1], level: 3 });
    }
  }

  return headings;
}

/**
 * MarkdownRenderer component
 *
 * Renders markdown content with proper styling and XSS protection.
 */
export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const html = renderMarkdown(content);

  return (
    <div
      className={cn('prose prose-sm max-w-none', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
