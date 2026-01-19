/**
 * HelpButton component
 *
 * Reusable help button that maps feature IDs to documentation
 * and opens the DocsViewer dialog.
 */

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { DocsViewer } from './DocsViewer';
import { FEATURE_DOC_MAP } from '@/ui/lib/docs';
import { cn } from '@/ui/lib/utils';

export interface HelpButtonProps {
  /** Feature ID to look up in FEATURE_DOC_MAP */
  featureId: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * HelpButton component
 *
 * Renders a help icon button that opens documentation for the specified feature.
 * Returns null if no documentation exists for the feature (graceful degradation).
 */
export function HelpButton({ featureId, className }: HelpButtonProps) {
  const [open, setOpen] = useState(false);

  // Look up doc slug for this feature
  const docSlug = FEATURE_DOC_MAP[featureId];

  // Graceful degradation: don't render if no doc exists
  if (!docSlug) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-6 w-6', className)}
        onClick={() => setOpen(true)}
        aria-label="Help"
      >
        <HelpCircle className="h-4 w-4 text-muted-foreground" />
      </Button>
      <DocsViewer open={open} onOpenChange={setOpen} slug={docSlug} />
    </>
  );
}
