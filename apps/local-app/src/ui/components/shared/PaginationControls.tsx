import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { cn } from '@/ui/lib/utils';

/** Available page size options */
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface PaginationControlsProps {
  /** Current page number (1-indexed) */
  page: number;
  /** Number of items per page */
  pageSize: number;
  /** Total number of items */
  totalItems: number;
  /** Callback when page changes */
  onPageChange: (page: number) => void;
  /** Callback when page size changes */
  onPageSizeChange: (pageSize: number) => void;
  /** Optional className for container */
  className?: string;
  /** Compact mode - hides some elements on smaller screens */
  compact?: boolean;
}

/**
 * PaginationControls - Reusable pagination component for tables
 *
 * Features:
 * - Page size selector with common options (10, 25, 50, 100)
 * - Navigation buttons: First, Prev, Next, Last
 * - Page info display: "Page X of Y" and "Showing X-Y of Z items"
 * - Proper disabled states on first/last pages
 * - Keyboard accessible
 */
export function PaginationControls({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  className,
  compact = false,
}: PaginationControlsProps) {
  // Calculate pagination values
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  // Navigation states
  const isFirstPage = currentPage <= 1;
  const isLastPage = currentPage >= totalPages;

  // Handlers
  const goToFirst = () => onPageChange(1);
  const goToPrev = () => onPageChange(currentPage - 1);
  const goToNext = () => onPageChange(currentPage + 1);
  const goToLast = () => onPageChange(totalPages);

  const handlePageSizeChange = (value: string) => {
    const newPageSize = parseInt(value, 10);
    onPageSizeChange(newPageSize);
    // Reset to page 1 when changing page size to avoid out-of-bounds
    onPageChange(1);
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 text-sm',
        compact && 'flex-wrap',
        className,
      )}
    >
      {/* Left side: Page size selector and item count */}
      <div className="flex items-center gap-4">
        {/* Page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger className="h-8 w-[70px]" aria-label="Select page size">
              <SelectValue placeholder={String(pageSize)} />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Item count - hidden in compact mode on small screens */}
        {!compact && (
          <span className="text-muted-foreground whitespace-nowrap">
            Showing {startItem}-{endItem} of {totalItems} items
          </span>
        )}
      </div>

      {/* Right side: Page info and navigation */}
      <div className="flex items-center gap-2">
        {/* Page info */}
        <span className="text-muted-foreground whitespace-nowrap">
          Page {currentPage} of {totalPages}
        </span>

        {/* Navigation buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goToFirst}
            disabled={isFirstPage}
            aria-label="Go to first page"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goToPrev}
            disabled={isFirstPage}
            aria-label="Go to previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goToNext}
            disabled={isLastPage}
            aria-label="Go to next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goToLast}
            disabled={isLastPage}
            aria-label="Go to last page"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
