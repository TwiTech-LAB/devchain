import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { AlertTriangle, Package, Globe } from 'lucide-react';
import { RegistryFilters } from './RegistryFilters';
import { TemplateGrid, TemplateGridSkeleton } from './TemplateGrid';
import { TemplateDetailDrawer } from './TemplateDetailDrawer';
import { DownloadedTemplates } from './DownloadedTemplates';
import type { TemplateCardData } from './TemplateCard';

/**
 * Feature flag to show/hide search and category filters.
 * Currently disabled as only 3 templates exist.
 * TODO: Re-enable when template count increases significantly (e.g., 10+)
 */
const SHOW_FILTERS = false;

interface RegistryStatusResponse {
  available: boolean;
  url: string;
}

interface TemplateListResponse {
  templates: TemplateCardData[];
  total: number;
  page: number;
  limit: number;
}

async function fetchRegistryStatus(): Promise<RegistryStatusResponse> {
  const res = await fetch('/api/registry/status');
  if (!res.ok) throw new Error('Failed to check registry status');
  return res.json();
}

async function fetchRegistryTemplates(params: {
  search?: string;
  category?: string;
}): Promise<TemplateListResponse> {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.category) searchParams.set('category', params.category);

  const url = `/api/registry/templates${searchParams.toString() ? `?${searchParams}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch templates');
  return res.json();
}

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export function RegistryPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>();

  // Debounce search input
  const debouncedSearch = useDebounce(search, 300);

  // Check registry availability
  const { data: registryStatus } = useQuery({
    queryKey: ['registry-status'],
    queryFn: fetchRegistryStatus,
    refetchInterval: 60000, // Check every minute
    staleTime: 30000,
  });

  // Fetch templates
  const {
    data: templatesData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['registry-templates', debouncedSearch, category],
    queryFn: () =>
      fetchRegistryTemplates({
        search: debouncedSearch || undefined,
        category,
      }),
  });

  const templates = useMemo(() => templatesData?.templates || [], [templatesData]);

  return (
    <div className="flex h-full flex-col">
      {/* Page Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <Package className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Template Registry</h1>
            <p className="text-muted-foreground">Browse and install project templates</p>
          </div>
        </div>
      </div>

      {/* Registry Offline Banner */}
      {registryStatus && !registryStatus.available && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Registry unavailable. Showing cached templates only.</AlertDescription>
        </Alert>
      )}

      {/* Downloaded Templates Section */}
      <div className="mb-8">
        <DownloadedTemplates />
      </div>

      {/* Search and Filters - hidden when SHOW_FILTERS is false */}
      {SHOW_FILTERS && (
        <div className="mb-6">
          <RegistryFilters
            search={search}
            onSearchChange={setSearch}
            category={category}
            onCategoryChange={setCategory}
          />
        </div>
      )}

      {/* Browse Registry Section */}
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Globe className="h-5 w-5" />
          Browse Registry
        </h2>
        <p className="text-sm text-muted-foreground">
          Discover and download templates from the online registry
        </p>
      </div>

      {/* Template Grid */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <TemplateGridSkeleton />
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="mb-4 h-12 w-12 text-destructive" />
            <p className="text-lg font-medium text-destructive">Failed to load templates</p>
            <p className="text-sm text-muted-foreground">
              Please check your connection and try again
            </p>
          </div>
        ) : (
          <TemplateGrid templates={templates} onSelect={setSelectedTemplate} />
        )}
      </div>

      {/* Template Detail Drawer */}
      <TemplateDetailDrawer
        slug={selectedTemplate}
        onClose={() => setSelectedTemplate(undefined)}
      />
    </div>
  );
}
