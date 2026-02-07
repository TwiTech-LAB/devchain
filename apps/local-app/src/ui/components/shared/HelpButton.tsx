/**
 * HelpButton component
 *
 * Reusable help button that maps feature IDs to documentation
 * and opens the DocsViewer dialog.
 */

import { useState, useCallback } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { DocsViewer } from './DocsViewer';
import { FEATURE_DOC_MAP } from '@/ui/lib/docs';
import { cn } from '@/ui/lib/utils';

const DOCS_VIEWED_KEY = 'devchain:docs-viewed';

function getViewedDocs(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(DOCS_VIEWED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function markDocViewed(featureId: string): void {
  const viewed = getViewedDocs();
  viewed[featureId] = true;
  window.localStorage.setItem(DOCS_VIEWED_KEY, JSON.stringify(viewed));
}

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
 * Shows a pulsing indicator until the user opens the doc at least once.
 * Viewed state persists in localStorage across restarts.
 * Returns null if no documentation exists for the feature (graceful degradation).
 */
export function HelpButton({ featureId, className }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => getViewedDocs()[featureId] === true);

  // Look up doc slug for this feature
  const docSlug = FEATURE_DOC_MAP[featureId];

  // Graceful degradation: don't render if no doc exists
  if (!docSlug) return null;

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen);
      if (isOpen && !seen) {
        markDocViewed(featureId);
        setSeen(true);
      }
    },
    [featureId, seen],
  );

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-6 w-6', className)}
        onClick={() => handleOpenChange(true)}
        aria-label="Help"
      >
        <HelpCircle className={cn('h-4 w-4', seen ? 'text-muted-foreground' : 'text-primary')} />
      </Button>
      <DocsViewer open={open} onOpenChange={handleOpenChange} slug={docSlug} />
    </>
  );
}
