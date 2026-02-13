import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  CheckCircle2,
  Calendar,
  User,
  Plus,
  FolderOpen,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { isLessThan } from '@devchain/shared';
import { VersionList } from './VersionList';
import { CreateFromRegistryDialog } from './CreateFromRegistryDialog';

interface TemplateVersion {
  version: string;
  minDevchainVersion: string | null;
  changelog: string | null;
  publishedAt: string;
  downloadCount?: number; // Optional - may be hidden from public API
  isLatest: boolean;
}

interface TemplateDetail {
  slug: string;
  name: string;
  description: string | null;
  authorName: string | null;
  license: string | null;
  category: string | null;
  tags: string[];
  requiredProviders: string[];
  isOfficial: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDetailResponse {
  template: TemplateDetail;
  versions: TemplateVersion[];
}

interface ProjectUsingTemplate {
  projectId: string;
  projectName: string | null;
  installedVersion: string;
  installedAt: string;
  lastUpdateCheckAt: string | null;
}

interface ProjectsUsingTemplateResponse {
  projects: ProjectUsingTemplate[];
}

async function fetchTemplateDetail(slug: string): Promise<TemplateDetailResponse | null> {
  const res = await fetch(`/api/registry/templates/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error('Failed to fetch template details');
  }
  return res.json();
}

async function fetchProjectsUsingTemplate(slug: string): Promise<ProjectsUsingTemplateResponse> {
  const res = await fetch(`/api/registry/projects/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error('Failed to fetch projects');
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

interface TemplateDetailDrawerProps {
  slug: string | undefined;
  onClose: () => void;
}

// Threshold for collapsing long descriptions (in characters)
const DESCRIPTION_COLLAPSE_THRESHOLD = 200;

export function TemplateDetailDrawer({ slug, onClose }: TemplateDetailDrawerProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showInstalledProjects, setShowInstalledProjects] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['registry-template', slug],
    queryFn: () => fetchTemplateDetail(slug!),
    enabled: !!slug,
  });

  const { data: projectsData } = useQuery({
    queryKey: ['registry-projects-using', slug],
    queryFn: () => fetchProjectsUsingTemplate(slug!),
    enabled: !!slug,
  });

  // Get current Devchain version for compatibility checks
  const { data: currentVersion } = useQuery({
    queryKey: ['health'],
    queryFn: fetchAppVersion,
    staleTime: Infinity, // Version doesn't change during runtime
  });

  const template = data?.template;
  const versions = data?.versions || [];
  const latestVersion = versions.find((v) => v.isLatest);
  const projectsUsingTemplate = projectsData?.projects || [];

  // Check if latest version is compatible with current Devchain version
  const isLatestCompatible = isVersionCompatible(
    latestVersion?.minDevchainVersion ?? null,
    currentVersion ?? null,
  );

  // Check if any project has an update available
  const getUpdateStatus = (installedVersion: string) => {
    if (!latestVersion) return false;
    return installedVersion !== latestVersion.version;
  };

  return (
    <Dialog open={!!slug} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
        {isLoading ? (
          <div className="p-6">
            <VisuallyHidden>
              <DialogTitle>Loading Template Details</DialogTitle>
              <DialogDescription>
                Loading template metadata and version information.
              </DialogDescription>
            </VisuallyHidden>
            <Skeleton className="mb-2 h-8 w-48" />
            <Skeleton className="mb-4 h-4 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : error ? (
          <div className="p-6">
            <VisuallyHidden>
              <DialogTitle>Error Loading Template</DialogTitle>
              <DialogDescription>
                An error occurred while loading template details.
              </DialogDescription>
            </VisuallyHidden>
            <p className="text-destructive">Failed to load template details</p>
          </div>
        ) : !template ? (
          <div className="p-6">
            <VisuallyHidden>
              <DialogTitle>Template Not Found</DialogTitle>
              <DialogDescription>
                The requested template could not be found in the registry.
              </DialogDescription>
            </VisuallyHidden>
            <p className="text-muted-foreground">Template not found</p>
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-6 py-4">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-lg">{template.name}</DialogTitle>
                {template.isOfficial && (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <CheckCircle2 className="h-3 w-3" />
                    Official
                  </Badge>
                )}
              </div>
              <DialogDescription className="sr-only">
                Template metadata, versions, and project usage details.
              </DialogDescription>
              {/* Collapsible Description */}
              {template.description && (
                <div className="mt-2">
                  {template.description.length > DESCRIPTION_COLLAPSE_THRESHOLD ? (
                    <div>
                      <p className="whitespace-pre-line text-sm text-muted-foreground">
                        {showFullDescription
                          ? template.description
                          : `${template.description.slice(0, DESCRIPTION_COLLAPSE_THRESHOLD)}...`}
                      </p>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => setShowFullDescription(!showFullDescription)}
                      >
                        {showFullDescription ? 'Show less' : 'Show more'}
                      </Button>
                    </div>
                  ) : (
                    <p className="whitespace-pre-line text-sm text-muted-foreground">
                      {template.description}
                    </p>
                  )}
                </div>
              )}
            </DialogHeader>

            <ScrollArea className="max-h-[55vh]">
              <div className="space-y-4 px-6 py-4">
                {/* Compact Metadata Row */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  {template.authorName && (
                    <span className="flex items-center gap-1">
                      <User className="h-3.5 w-3.5" />
                      {template.authorName}
                    </span>
                  )}
                  {template.category && (
                    <Badge variant="outline" className="text-xs">
                      {template.category}
                    </Badge>
                  )}
                  {template.requiredProviders.length > 0 &&
                    template.requiredProviders.map((provider) => (
                      <Badge key={provider} variant="outline" className="text-xs">
                        {provider}
                      </Badge>
                    ))}
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    {new Date(template.updatedAt).toLocaleDateString()}
                  </span>
                </div>

                {/* Tags - inline with label */}
                {template.tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <span className="text-muted-foreground">Tags:</span>
                    {template.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Collapsible Projects Using This Template */}
                {projectsUsingTemplate.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full justify-between p-0 font-medium hover:bg-transparent"
                        onClick={() => setShowInstalledProjects(!showInstalledProjects)}
                      >
                        <span className="text-sm">
                          Installed In ({projectsUsingTemplate.length} project
                          {projectsUsingTemplate.length > 1 ? 's' : ''})
                        </span>
                        {showInstalledProjects ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                      {showInstalledProjects && (
                        <div className="mt-2 space-y-1">
                          {projectsUsingTemplate.map((project) => {
                            const hasUpdate = getUpdateStatus(project.installedVersion);
                            const displayName =
                              project.projectName || `ID: ${project.projectId.slice(0, 8)}...`;
                            return (
                              <div
                                key={project.projectId}
                                className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm"
                                title={`Project ID: ${project.projectId}`}
                              >
                                <div className="flex items-center gap-2">
                                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span>{displayName}</span>
                                  <Badge variant="outline" className="text-xs">
                                    v{project.installedVersion}
                                  </Badge>
                                </div>
                                {hasUpdate && (
                                  <Badge variant="default" className="gap-1 text-xs">
                                    <AlertCircle className="h-3 w-3" />
                                    Update
                                  </Badge>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}

                <Separator />

                {/* Versions with Download Actions */}
                <div>
                  <h4 className="mb-2 text-sm font-medium">Versions</h4>
                  <VersionList versions={versions} slug={slug!} />
                </div>
              </div>
            </ScrollArea>

            {/* Footer Actions */}
            <div className="flex items-center justify-end gap-2 border-t p-4">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <TooltipProvider>
                {!isLatestCompatible && latestVersion?.minDevchainVersion ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button disabled>
                          <AlertTriangle className="mr-2 h-4 w-4" />
                          Incompatible Version
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        Requires Devchain v{latestVersion.minDevchainVersion}+
                        <br />
                        Current: v{currentVersion}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button onClick={() => setShowCreateDialog(true)} disabled={!latestVersion}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create New Project
                  </Button>
                )}
              </TooltipProvider>
            </div>

            {/* Create Project Dialog */}
            {latestVersion && (
              <CreateFromRegistryDialog
                slug={slug!}
                version={latestVersion.version}
                templateName={template.name}
                open={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
