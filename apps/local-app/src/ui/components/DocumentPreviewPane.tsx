import { useMemo } from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { ChevronRight, Edit, ExternalLink } from 'lucide-react';

interface Document {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  contentMd: string;
  archived: boolean;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface Heading {
  id: string;
  level: number;
  text: string;
}

interface DocumentPreviewPaneProps {
  document: Document;
  allDocuments: Document[];
  onNavigate: (document: Document) => void;
  onEdit?: (document: Document) => void;
  className?: string;
}

/**
 * Extract headings from markdown content
 */
function extractHeadings(content: string): Heading[] {
  const lines = content.split('\n');
  const seen = new Map<string, number>();
  const result: Heading[] = [];

  lines.forEach((line) => {
    const match = line.match(/^(#{1,3})\s+(.*)$/);
    if (!match) {
      return;
    }
    const level = match[1].length;
    const text = match[2].trim();
    let slug = slugifyHeading(text);
    const count = seen.get(slug) ?? 0;
    if (count > 0) {
      slug = `${slug}-${count + 1}`;
    }
    seen.set(slug, count + 1);
    result.push({ id: `heading-${slug}`, level, text });
  });

  return result;
}

function slugifyHeading(value: string) {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'heading';
}

/**
 * Extract outgoing links ([[slug]]) from markdown content
 */
function extractOutgoingLinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    const slug = match[1].trim();
    if (slug && !links.includes(slug)) {
      links.push(slug);
    }
  }

  return links;
}

/**
 * Simple markdown preview component with link resolution
 */
function MarkdownPreview({
  content,
  resolveSlug,
  onNavigate,
  headingAnchors = [],
}: {
  content: string;
  resolveSlug: (slug: string) => Document | undefined;
  onNavigate: (document: Document) => void;
  headingAnchors?: Heading[];
}) {
  let headingIndex = 0;

  const renderInline = (text: string) => {
    if (!text) {
      return null;
    }

    const tokens = text.split(/(\[\[[^\]]+\]\])/g);
    return tokens.map((token, idx) => {
      if (!token) {
        return null;
      }

      const isReference = token.startsWith('[[') && token.endsWith(']]');
      if (!isReference) {
        return <span key={idx}>{token}</span>;
      }

      const slug = token.slice(2, -2).trim();
      if (!slug) {
        return <span key={idx} />;
      }

      const resolved = resolveSlug(slug);
      if (resolved) {
        return (
          <button
            key={`${slug}-${idx}`}
            type="button"
            className="text-primary underline decoration-dotted underline-offset-4 hover:text-primary/80"
            onClick={() => onNavigate(resolved)}
          >
            {resolved.title || slug}
          </button>
        );
      }

      return (
        <span
          key={`${slug}-${idx}`}
          className="border-b border-dashed border-amber-500 text-amber-600"
          title="Document not found"
        >
          {slug}
        </span>
      );
    });
  };

  const renderContent = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h1 key={idx} id={headingId} className="text-2xl font-bold mb-2">
            {renderInline(line.substring(2))}
          </h1>
        );
      }
      if (line.startsWith('## ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h2 key={idx} id={headingId} className="text-xl font-semibold mb-2">
            {renderInline(line.substring(3))}
          </h2>
        );
      }
      if (line.startsWith('### ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h3 key={idx} id={headingId} className="text-lg font-semibold mb-1">
            {renderInline(line.substring(4))}
          </h3>
        );
      }
      if (line.startsWith('- ')) {
        return (
          <li key={idx} className="ml-4 list-disc">
            {renderInline(line.substring(2))}
          </li>
        );
      }
      if (line.trim() === '') {
        return <div key={idx} className="h-2" />;
      }
      return (
        <p key={idx} className="mb-2">
          {renderInline(line)}
        </p>
      );
    });
  };

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">{renderContent(content)}</div>
  );
}

/**
 * DocumentPreviewPane displays a read-only preview of a document
 * with headings outline, backlinks, and outgoing links
 */
export function DocumentPreviewPane({
  document,
  allDocuments,
  onNavigate,
  onEdit,
  className,
}: DocumentPreviewPaneProps) {
  const headings = useMemo(() => extractHeadings(document.contentMd), [document.contentMd]);

  const outgoingLinks = useMemo(
    () => extractOutgoingLinks(document.contentMd),
    [document.contentMd],
  );

  const resolveSlug = (slug: string) =>
    allDocuments.find(
      (doc) => doc.slug === slug && (doc.projectId ?? null) === (document.projectId ?? null),
    );

  const backlinks = useMemo(() => {
    const token = `[[${document.slug}]]`;
    return allDocuments.filter((doc) => doc.id !== document.id && doc.contentMd.includes(token));
  }, [document, allDocuments]);

  const resolvedOutgoingLinks = useMemo(() => {
    return outgoingLinks.map((slug) => ({
      slug,
      document: resolveSlug(slug),
    }));
  }, [outgoingLinks, allDocuments, document.projectId]);

  const handleOutlineClick = (anchorId: string) => {
    const target = window.document.getElementById(anchorId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className={cn('flex flex-col h-full border-l border-border bg-card', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold truncate">{document.title}</h2>
          <p className="text-xs text-muted-foreground">
            Updated {new Date(document.updatedAt).toLocaleString()}
          </p>
        </div>
        {onEdit && (
          <Button variant="outline" size="sm" onClick={() => onEdit(document)} className="ml-2">
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {/* Document Preview */}
        <div>
          <MarkdownPreview
            content={document.contentMd}
            resolveSlug={resolveSlug}
            onNavigate={onNavigate}
            headingAnchors={headings}
          />
        </div>

        {/* Outline */}
        {headings.length > 0 && (
          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold uppercase text-muted-foreground mb-2">Outline</h3>
            <ul className="space-y-1 text-sm">
              {headings.map((heading) => (
                <li key={heading.id}>
                  <button
                    type="button"
                    className={cn(
                      'w-full truncate text-left text-muted-foreground hover:text-primary transition-colors',
                      heading.level === 1 && 'pl-0 font-medium text-foreground',
                      heading.level === 2 && 'pl-3',
                      heading.level === 3 && 'pl-6 text-xs',
                    )}
                    onClick={() => handleOutlineClick(heading.id)}
                  >
                    <ChevronRight className="inline h-3 w-3 mr-1" />
                    {heading.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Outgoing Links */}
        {outgoingLinks.length > 0 && (
          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold uppercase text-muted-foreground mb-2">
              Outgoing Links ({outgoingLinks.length})
            </h3>
            <ul className="space-y-1">
              {resolvedOutgoingLinks.map(({ slug, document: linkedDoc }) => (
                <li key={slug}>
                  {linkedDoc ? (
                    <button
                      type="button"
                      className="flex items-center gap-2 text-primary underline underline-offset-4 decoration-dotted hover:text-primary/80 text-sm"
                      onClick={() => onNavigate(linkedDoc)}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {linkedDoc.title || slug}
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 text-amber-600 text-sm">
                      <ExternalLink className="h-3 w-3" />
                      {slug}
                      <span className="text-xs text-muted-foreground">(not found)</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Backlinks */}
        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold uppercase text-muted-foreground mb-2">
            Backlinks ({backlinks.length})
          </h3>
          {backlinks.length > 0 ? (
            <ul className="space-y-1">
              {backlinks.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-primary underline underline-offset-4 decoration-dotted hover:text-primary/80 text-sm"
                    onClick={() => onNavigate(doc)}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {doc.title || doc.slug}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No backlinks yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
