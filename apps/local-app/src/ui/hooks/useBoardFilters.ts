import { useLocation } from 'react-router-dom';
import { useMemo } from 'react';
import { parseBoardFilters, type BoardFilterParams } from '@/ui/lib/url-filters';

/**
 * Reads Board filters from the URL. Parse-once-per-location change.
 * Unknown params are ignored by the parser.
 */
export function useBoardFilters(): { filters: BoardFilterParams } {
  const location = useLocation();

  const filters = useMemo(() => {
    return parseBoardFilters(location.search);
  }, [location.search]);

  return { filters };
}
