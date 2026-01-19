import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { Input } from '@/ui/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { cn } from '@/ui/lib/utils';
import type { Epic, Status, EpicsQueryData } from '@/ui/types';

export interface EpicSearchInputProps {
  /** Project ID for scoping the search */
  projectId: string;
  /** Optional className for the container */
  className?: string;
}

interface StatusesResponse {
  items: Status[];
}

async function searchEpics(projectId: string, q: string): Promise<EpicsQueryData> {
  const params = new URLSearchParams({ projectId, q, limit: '10' });
  const res = await fetch(`/api/epics?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to search epics');
  return res.json();
}

async function fetchStatuses(projectId: string): Promise<StatusesResponse> {
  const res = await fetch(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

/**
 * EpicSearchInput - Search input with dropdown results for finding epics
 *
 * Features:
 * - Debounced search (300ms) by title or UUID prefix
 * - Dropdown shows matching results with status color
 * - Keyboard navigation (arrow keys, Enter)
 * - Click or Enter navigates to epic detail
 */
export function EpicSearchInput({ projectId, className }: EpicSearchInputProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery]);

  // Fetch statuses for color display (only when dropdown active with query)
  const { data: statusesData } = useQuery({
    queryKey: ['statuses', projectId],
    queryFn: () => fetchStatuses(projectId),
    enabled: !!projectId && open && debouncedQuery.length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const statusMap = new Map(statusesData?.items.map((s) => [s.id, s]) ?? []);

  // Search epics (only when dropdown active with query)
  const {
    data: searchData,
    isLoading,
    isFetching,
    isError,
  } = useQuery({
    queryKey: ['epic-search', projectId, debouncedQuery],
    queryFn: () => searchEpics(projectId, debouncedQuery),
    enabled: !!projectId && open && debouncedQuery.length > 0,
    staleTime: 30 * 1000, // 30 seconds
  });

  const results = searchData?.items ?? [];
  const showLoading = isLoading || isFetching;
  const showResults = debouncedQuery.length > 0;

  // Navigate to epic
  const navigateToEpic = useCallback(
    (epic: Epic) => {
      navigate(`/epics/${epic.id}`);
      setOpen(false);
      setQuery('');
    },
    [navigate],
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showResults) return;
      if (results.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOpen(false);
          inputRef.current?.blur();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results.length === 1) {
            // Single result: navigate directly
            navigateToEpic(results[0]);
          } else if (results.length > 0 && selectedIndex < results.length) {
            // Multiple results: navigate to selected
            navigateToEpic(results[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          inputRef.current?.blur();
          break;
      }
    },
    [showResults, results, selectedIndex, navigateToEpic],
  );

  // Handle focus
  const handleFocus = useCallback(() => {
    setOpen(true);
  }, []);

  // Handle input change
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setOpen(true);
  }, []);

  // Get short ID (first 8 chars)
  const getShortId = (id: string) => id.slice(0, 8);

  return (
    <Popover open={open && showResults} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className={cn('relative', className)}>
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Search epics..."
            value={query}
            onChange={handleChange}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            className="h-9 w-64 pl-8 pr-8"
            aria-label="Search epics"
            aria-expanded={open && showResults}
            aria-haspopup="listbox"
          />
          {showLoading && (
            <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ScrollArea className="max-h-64">
          {isError ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Search failed. Please try again.</span>
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {showLoading ? 'Searching...' : 'No results found'}
            </div>
          ) : (
            <div className="py-1" role="listbox">
              {results.map((epic, index) => {
                const status = statusMap.get(epic.statusId);
                return (
                  <Link
                    key={epic.id}
                    to={`/epics/${epic.id}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent cursor-pointer',
                      index === selectedIndex && 'bg-accent',
                    )}
                    onClick={(e) => {
                      // Only close popover on regular left-click
                      // Don't close on: middle-click (button !== 0), Ctrl/Cmd+click, or Shift+click
                      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                        setOpen(false);
                        setQuery('');
                      }
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    {/* Status color dot */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: status?.color ?? '#6c757d' }}
                      aria-label={status?.label ?? 'Unknown status'}
                    />
                    {/* Sub-epic indicator */}
                    {epic.parentId && (
                      <span className="shrink-0 text-muted-foreground" aria-label="Sub-epic">
                        ↳
                      </span>
                    )}
                    {/* Epic title (truncated) */}
                    <span className="flex-1 truncate">{epic.title}</span>
                    {/* Short ID */}
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {getShortId(epic.id)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
