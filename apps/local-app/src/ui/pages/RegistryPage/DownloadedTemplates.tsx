import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useToast } from '@/ui/hooks/use-toast';
import {
  ChevronDown,
  ChevronRight,
  Package,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  X,
  Loader2,
} from 'lucide-react';
import {
  type TemplateUpdateStatus,
  checkAllTemplateUpdates,
  type CachedTemplateInfo,
} from '@/ui/lib/registry-updates';

/**
 * Template info from the unified templates API (extends CachedTemplateInfo with display fields)
 */
interface UnifiedTemplateInfo extends CachedTemplateInfo {
  name: string;
  description: string | null;
  versions: string[] | null;
}

/**
 * API response from /api/templates
 */
interface TemplatesResponse {
  templates: UnifiedTemplateInfo[];
  total: number;
}

/**
 * Fetch templates from the unified API
 */
async function fetchTemplates(): Promise<TemplatesResponse> {
  const res = await fetch('/api/templates');
  if (!res.ok) {
    throw new Error('Failed to fetch templates');
  }
  return res.json();
}

/**
 * Delete a specific template version
 */
async function deleteTemplateVersion(slug: string, version: string): Promise<void> {
  const res = await fetch(
    `/api/templates/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete version' }));
    throw new Error(error.message || 'Failed to delete version');
  }
}

/**
 * Download a template version from registry
 */
async function downloadTemplateVersion(slug: string, version: string): Promise<void> {
  const res = await fetch(
    `/api/registry/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to download template' }));
    throw new Error(error.message || 'Failed to download template');
  }
}

/**
 * Update status badge component
 * Handles different states for both bundled and downloaded templates
 */
function UpdateBadge({
  status,
  source,
  onDownload,
  isDownloading,
}: {
  status: TemplateUpdateStatus;
  source: 'bundled' | 'registry';
  onDownload?: () => void;
  isDownloading?: boolean;
}) {
  const isBundled = source === 'bundled';

  switch (status.status) {
    case 'checking':
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" />
          Checking...
        </Badge>
      );
    case 'update-available':
      return (
        <Button
          size="sm"
          variant="default"
          className="h-6 gap-1 bg-blue-600 hover:bg-blue-700 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onDownload?.();
          }}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <Download className="h-3 w-3" />
              Download v{status.remoteVersion}
            </>
          )}
        </Button>
      );
    case 'up-to-date':
      return (
        <Badge variant="outline" className="gap-1 text-green-600 border-green-600/50">
          <CheckCircle2 className="h-3 w-3" />
          Up to date
        </Badge>
      );
    case 'offline':
      // Bundled templates don't show "Offline" since they work locally
      if (isBundled) {
        return null;
      }
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          Offline
        </Badge>
      );
    case 'not-in-registry':
      // Template not published to registry - show muted indicator
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground text-xs">
          Not in registry
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * Individual installed template item with expandable versions
 */
function DownloadedTemplateItem({
  template,
  updateStatus,
  onRemoveVersion,
  deletingVersion,
  onDownload,
  isDownloading,
}: {
  template: UnifiedTemplateInfo;
  updateStatus: TemplateUpdateStatus;
  onRemoveVersion: (slug: string, version: string) => void;
  deletingVersion: string | null;
  onDownload: (slug: string, version: string) => void;
  isDownloading: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const contentId = `template-versions-${template.slug}`;
  const isBundled = template.source === 'bundled';
  const hasVersions = template.versions && template.versions.length > 0;

  // Only allow expansion if there are versions to show (registry templates)
  const canExpand = !isBundled && hasVersions;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!canExpand) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded(!isExpanded);
    }
  };

  const handleClick = () => {
    if (canExpand) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div className="rounded-lg border bg-card">
      <div
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        className={`flex w-full items-center justify-between p-4 text-left ${canExpand ? 'hover:bg-muted/50 cursor-pointer' : ''}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-expanded={canExpand ? isExpanded : undefined}
        aria-controls={canExpand ? contentId : undefined}
      >
        <div className="flex items-center gap-3">
          <Package className="h-5 w-5 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{template.name}</span>
              <Badge variant={isBundled ? 'outline' : 'secondary'} className="text-xs">
                {isBundled ? 'Bundled' : 'Downloaded'}
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              {isBundled ? (
                'Built-in template'
              ) : (
                <>
                  {template.versions?.length || 0} version
                  {(template.versions?.length || 0) !== 1 ? 's' : ''} cached
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <UpdateBadge
            status={updateStatus}
            source={template.source}
            onDownload={
              updateStatus.status === 'update-available'
                ? () => onDownload(template.slug, updateStatus.remoteVersion)
                : undefined
            }
            isDownloading={isDownloading}
          />
          {template.latestVersion && <Badge variant="secondary">v{template.latestVersion}</Badge>}
          {canExpand &&
            (isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            ))}
        </div>
      </div>

      {canExpand && isExpanded && (
        <div id={contentId} className="border-t px-4 py-3">
          <div className="mb-2 text-sm font-medium text-muted-foreground">Cached Versions</div>
          <div className="flex flex-wrap gap-2">
            {template.versions!.map((version) => (
              <div key={version} className="flex items-center gap-1">
                <Badge
                  variant={version === template.latestVersion ? 'default' : 'outline'}
                  className="gap-1"
                >
                  <Download className="h-3 w-3" />v{version}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveVersion(template.slug, version);
                  }}
                  disabled={deletingVersion === version}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Loading skeleton for the downloaded templates section
 */
function DownloadedTemplatesSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-5" />
            <div className="flex-1">
              <Skeleton className="mb-2 h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Empty state when no installed templates exist
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <Package className="mb-3 h-10 w-10 text-muted-foreground" />
      <div className="mb-1 font-medium">No installed templates</div>
      <div className="text-sm text-muted-foreground">
        Download templates from the registry or add bundled templates
      </div>
    </div>
  );
}

/**
 * DownloadedTemplates component
 *
 * Displays locally cached registry templates with their versions
 * in an expandable list format. Checks for updates asynchronously.
 */
export function DownloadedTemplates() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['unified-templates'],
    queryFn: fetchTemplates,
  });

  // Track update status for each template
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, TemplateUpdateStatus>>({});

  // State for deletion confirmation dialog
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; version: string } | null>(null);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: ({ slug, version }: { slug: string; version: string }) =>
      deleteTemplateVersion(slug, version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unified-templates'] });
      toast({
        title: 'Success',
        description: 'Template version removed successfully',
      });
      setDeleteTarget(null);
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove version',
        variant: 'destructive',
      });
      setDeleteTarget(null);
    },
  });

  const handleRemoveVersion = (slug: string, version: string) => {
    setDeleteTarget({ slug, version });
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget);
    }
  };

  // State for tracking which template is being downloaded
  const [downloadingSlug, setDownloadingSlug] = useState<string | null>(null);

  // Download mutation
  const downloadMutation = useMutation({
    mutationFn: ({ slug, version }: { slug: string; version: string }) =>
      downloadTemplateVersion(slug, version),
    onMutate: ({ slug }) => {
      setDownloadingSlug(slug);
    },
    onSuccess: (_data, { slug, version }) => {
      queryClient.invalidateQueries({ queryKey: ['unified-templates'] });
      toast({
        title: 'Success',
        description: `Downloaded version ${version} successfully`,
      });
      setDownloadingSlug(null);
      // Clear update status for this template since we just downloaded
      // Use slug from mutation variables, not closure state
      setUpdateStatuses((prev) => ({ ...prev, [slug]: { status: 'up-to-date' } }));
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to download template',
        variant: 'destructive',
      });
      setDownloadingSlug(null);
    },
  });

  const handleDownload = (slug: string, version: string) => {
    downloadMutation.mutate({ slug, version });
  };

  // Show all templates (bundled + downloaded from registry)
  const installedTemplates = data?.templates || [];

  // Check for updates when templates change
  useEffect(() => {
    if (installedTemplates.length === 0) return;

    // Initialize all to "checking" state
    const initialStatuses: Record<string, TemplateUpdateStatus> = {};
    installedTemplates.forEach((t) => {
      initialStatuses[t.slug] = { status: 'checking' };
    });
    setUpdateStatuses(initialStatuses);

    // Check updates in parallel using shared utility
    const checkUpdates = async () => {
      const newStatuses = await checkAllTemplateUpdates(installedTemplates);
      setUpdateStatuses(newStatuses);
    };

    checkUpdates();
  }, [data]); // Re-run when templates data changes

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Installed Templates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DownloadedTemplatesSkeleton />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Installed Templates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-center text-sm text-destructive">
            Failed to load templates. Please try again later.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5" />
          Installed Templates
          {installedTemplates.length > 0 && (
            <Badge variant="secondary" className="ml-2">
              {installedTemplates.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {installedTemplates.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {installedTemplates.map((template) => (
              <DownloadedTemplateItem
                key={template.slug}
                template={template}
                updateStatus={updateStatuses[template.slug] || { status: 'idle' }}
                onRemoveVersion={handleRemoveVersion}
                deletingVersion={
                  deleteTarget?.slug === template.slug && deleteMutation.isPending
                    ? deleteTarget.version
                    : null
                }
                onDownload={handleDownload}
                isDownloading={downloadingSlug === template.slug && downloadMutation.isPending}
              />
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={confirmDelete}
        title="Remove template version"
        description={
          deleteTarget
            ? `Are you sure you want to remove version ${deleteTarget.version} of "${deleteTarget.slug}"? This will delete the cached files from disk.`
            : 'Are you sure you want to remove this version?'
        }
        confirmText="Remove"
        variant="destructive"
        loading={deleteMutation.isPending}
      />
    </Card>
  );
}
