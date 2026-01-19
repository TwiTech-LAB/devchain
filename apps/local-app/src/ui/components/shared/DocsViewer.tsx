/**
 * DocsViewer dialog component
 *
 * Full-screen dialog for viewing documentation. Displays document title,
 * description, and rendered markdown content.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { MarkdownRenderer } from './MarkdownRenderer';
import { getDocBySlug } from '@/ui/docs';
import { FileQuestion } from 'lucide-react';

export interface DocsViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
}

/**
 * Document not found state
 */
function DocNotFound({ slug }: { slug: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <FileQuestion className="h-12 w-12 mb-4" />
      <p className="text-lg font-medium">Document not found</p>
      <p className="text-sm">No documentation found for "{slug}"</p>
    </div>
  );
}

/**
 * DocsViewer dialog component
 *
 * Displays documentation content in a full-screen modal dialog.
 * Uses the docs registry to look up content by slug.
 */
export function DocsViewer({ open, onOpenChange, slug }: DocsViewerProps) {
  const doc = getDocBySlug(slug);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        {doc ? (
          <>
            <DialogHeader className="shrink-0">
              <DialogTitle className="text-xl">{doc.frontmatter.title}</DialogTitle>
              <DialogDescription>{doc.frontmatter.description}</DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto pr-2 -mr-2">
              <MarkdownRenderer content={doc.content} className="pb-4" />
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>Document not found</DialogTitle>
              <DialogDescription>The requested documentation could not be found.</DialogDescription>
            </DialogHeader>
            <DocNotFound slug={slug} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
