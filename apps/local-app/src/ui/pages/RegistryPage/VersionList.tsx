import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { Download, Check, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { isLessThan } from '@devchain/shared';

interface TemplateVersion {
  version: string;
  minDevchainVersion: string | null;
  changelog: string | null;
  publishedAt: string;
  downloadCount?: number; // Optional - may be hidden from public API
  isLatest: boolean;
}

interface VersionListProps {
  versions: TemplateVersion[];
  slug: string;
}

async function fetchCachedVersions(slug: string) {
  const res = await fetch(`/api/registry/cache/${encodeURIComponent(slug)}/versions`);
  if (!res.ok) throw new Error('Failed to fetch cached versions');
  return res.json();
}

async function downloadTemplateVersion(slug: string, version: string) {
  const res = await fetch(
    `/api/registry/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error('Failed to download template');
  return res.json();
}

async function fetchAppVersion(): Promise<string | null> {
  const res = await fetch('/health');
  if (!res.ok) return null;
  const data = await res.json();
  return data?.version || null;
}

/**
 * Check if a template version is compatible with the current Devchain version.
 * Returns true if compatible, false if incompatible.
 */
function isVersionCompatible(
  minDevchainVersion: string | null,
  currentVersion: string | null,
): boolean {
  if (!minDevchainVersion || !currentVersion) return true;
  try {
    return !isLessThan(currentVersion, minDevchainVersion);
  } catch {
    // If version comparison fails, assume compatible
    return true;
  }
}

export function VersionList({ versions, slug }: VersionListProps) {
  const queryClient = useQueryClient();
  const [showOlderVersions, setShowOlderVersions] = useState(false);

  // Get cached versions for this template
  const { data: cacheData } = useQuery({
    queryKey: ['registry-cache-versions', slug],
    queryFn: () => fetchCachedVersions(slug),
    enabled: !!slug,
  });

  // Get current Devchain version for compatibility checks
  const { data: currentVersion } = useQuery({
    queryKey: ['health'],
    queryFn: fetchAppVersion,
    staleTime: Infinity, // Version doesn't change during runtime
  });

  const cachedVersions = new Set<string>(cacheData?.versions || []);

  // Download mutation
  const downloadMutation = useMutation({
    mutationFn: ({ version }: { version: string }) => downloadTemplateVersion(slug, version),
    onSuccess: () => {
      // Invalidate cache queries to refresh status
      queryClient.invalidateQueries({ queryKey: ['registry-cache-versions', slug] });
      // Refresh Downloaded Templates section (uses unified-templates query key)
      queryClient.invalidateQueries({ queryKey: ['unified-templates'] });
      // Refresh templates-for-upgrade used by ProjectsPage upgrade badge
      queryClient.invalidateQueries({ queryKey: ['templates-for-upgrade'] });
    },
  });

  if (!versions || versions.length === 0) {
    return <p className="text-sm text-muted-foreground">No versions available</p>;
  }

  // Sort versions newest first
  const sortedVersions = [...versions].sort((a, b) => {
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  // Split into latest and older versions
  const latestVersion = sortedVersions[0];
  const olderVersions = sortedVersions.slice(1);
  const hasOlderVersions = olderVersions.length > 0;

  const renderVersion = (version: TemplateVersion) => {
    const isCached = cachedVersions.has(version.version);
    const isDownloading =
      downloadMutation.isPending && downloadMutation.variables?.version === version.version;
    const isCompatible = isVersionCompatible(version.minDevchainVersion, currentVersion ?? null);

    return (
      <div key={version.version} className="rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium">v{version.version}</span>
              {version.isLatest && (
                <Badge variant="secondary" className="text-xs">
                  Latest
                </Badge>
              )}
              {!isCompatible && version.minDevchainVersion && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-600 text-xs"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Incompatible
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Requires Devchain v{version.minDevchainVersion}+
                      <br />
                      Current: v{currentVersion}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>{new Date(version.publishedAt).toLocaleDateString()}</span>
              {version.downloadCount != null && (
                <span className="flex items-center gap-1">
                  <Download className="h-3.5 w-3.5" />
                  {version.downloadCount.toLocaleString()}
                </span>
              )}
            </div>
            {version.changelog && (
              <p className="mt-2 text-sm text-muted-foreground">{version.changelog}</p>
            )}
            {version.minDevchainVersion && isCompatible && (
              <p className="mt-1 text-xs text-muted-foreground">
                Requires Devchain v{version.minDevchainVersion}+
              </p>
            )}
          </div>

          {/* Version Actions */}
          <div className="ml-4">
            {isCached ? (
              <Badge variant="outline" className="gap-1">
                <Check className="h-3 w-3" />
                Downloaded
              </Badge>
            ) : !isCompatible ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" variant="outline" disabled>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Download
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    Requires Devchain v{version.minDevchainVersion}+
                    <br />
                    Current: v{currentVersion}
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadMutation.mutate({ version: version.version })}
                disabled={isDownloading}
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Downloading
                  </>
                ) : (
                  <>
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Download
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {/* Always show latest version */}
        {renderVersion(latestVersion)}

        {/* Collapse/Expand for older versions */}
        {hasOlderVersions && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground hover:text-foreground"
              onClick={() => setShowOlderVersions(!showOlderVersions)}
            >
              {showOlderVersions ? (
                <>
                  <ChevronUp className="mr-1 h-4 w-4" />
                  Hide {olderVersions.length} older version{olderVersions.length > 1 ? 's' : ''}
                </>
              ) : (
                <>
                  <ChevronDown className="mr-1 h-4 w-4" />
                  Show {olderVersions.length} older version{olderVersions.length > 1 ? 's' : ''}
                </>
              )}
            </Button>

            {showOlderVersions && olderVersions.map(renderVersion)}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
