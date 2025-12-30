import { useState, useMemo } from 'react';
import { isValidSemVer } from '@devchain/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, Upload, X } from 'lucide-react';

interface ManifestData {
  slug?: string;
  name?: string;
  description?: string | null;
  category?: 'development' | 'planning' | 'custom';
  tags?: string[];
  version?: string;
  changelog?: string;
  authorName?: string;
  minDevchainVersion?: string;
}

interface ExportDialogProps {
  projectId: string;
  projectName: string;
  existingManifest?: Partial<ManifestData>;
  open: boolean;
  onClose: () => void;
}

/**
 * Convert a string to a valid slug (lowercase, alphanumeric + hyphens)
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Bump a semver version string
 */
function bumpVersion(version: string, bump: 'major' | 'minor' | 'patch'): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.0.0';

  let [, major, minor, patch] = match.map(Number);

  switch (bump) {
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor++;
      patch = 0;
      break;
    case 'patch':
      patch++;
      break;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Download data as a JSON file
 */
function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportDialog({
  projectId,
  projectName,
  existingManifest,
  open,
  onClose,
}: ExportDialogProps) {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [tagInput, setTagInput] = useState('');

  // Initialize manifest state with existing values or defaults
  // Note: category is hardcoded to 'development' in the export payload
  const [manifest, setManifest] = useState<ManifestData>(() => ({
    slug: existingManifest?.slug || slugify(projectName),
    name: existingManifest?.name || projectName,
    description: existingManifest?.description || '',
    tags: existingManifest?.tags || [],
    version: bumpVersion(existingManifest?.version || '0.0.0', 'patch'),
    changelog: '',
    authorName: existingManifest?.authorName || '',
    minDevchainVersion: existingManifest?.minDevchainVersion || '',
  }));

  // Suggested versions based on current version
  const suggestedVersions = useMemo(() => {
    const base = existingManifest?.version || '0.0.0';
    return {
      patch: bumpVersion(base, 'patch'),
      minor: bumpVersion(base, 'minor'),
      major: bumpVersion(base, 'major'),
    };
  }, [existingManifest?.version]);

  // Validate minDevchainVersion if provided
  const isMinVersionValid = useMemo(() => {
    if (!manifest.minDevchainVersion) return true; // Empty is valid (optional field)
    return isValidSemVer(manifest.minDevchainVersion);
  }, [manifest.minDevchainVersion]);

  const handleExport = async () => {
    try {
      setIsExporting(true);

      // Call POST endpoint with manifest overrides
      // Category is hardcoded to 'development' (UI field was removed)
      const response = await fetch(`/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: { ...manifest, category: 'development' } }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Export failed' }));
        throw new Error(error.message || 'Export failed');
      }

      const data = await response.json();

      // Trigger download
      const filename = `${manifest.slug || slugify(projectName)}.json`;
      downloadJson(data, filename);

      toast({
        title: 'Export Complete',
        description: `Downloaded ${filename}`,
      });

      onClose();
    } catch (err) {
      toast({
        title: 'Export Failed',
        description: err instanceof Error ? err.message : 'Unable to export project',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !manifest.tags?.includes(tag)) {
      setManifest((prev) => ({
        ...prev,
        tags: [...(prev.tags || []), tag],
      }));
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setManifest((prev) => ({
      ...prev,
      tags: prev.tags?.filter((t) => t !== tagToRemove) || [],
    }));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Export Project</DialogTitle>
          <DialogDescription>
            Configure template metadata before exporting. These fields will be embedded in the
            exported JSON.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4 py-4 pr-4">
            {/* Slug */}
            <div className="space-y-2">
              <Label htmlFor="export-slug">Slug</Label>
              <Input
                id="export-slug"
                value={manifest.slug || ''}
                onChange={(e) => setManifest((prev) => ({ ...prev, slug: e.target.value }))}
                placeholder="my-template"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Unique identifier (lowercase, alphanumeric + hyphens)
              </p>
            </div>

            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="export-name">Name</Label>
              <Input
                id="export-name"
                value={manifest.name || ''}
                onChange={(e) => setManifest((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="My Template"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="export-description">Description</Label>
              <Textarea
                id="export-description"
                value={manifest.description || ''}
                onChange={(e) => setManifest((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="A brief description of what this template does"
                rows={2}
              />
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <Label htmlFor="export-tags">Tags</Label>
              <div className="flex gap-2">
                <Input
                  id="export-tags"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  placeholder="Add a tag..."
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddTag}
                  disabled={!tagInput.trim()}
                >
                  Add
                </Button>
              </div>
              {manifest.tags && manifest.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {manifest.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="cursor-pointer hover:bg-destructive hover:text-destructive-foreground"
                      onClick={() => handleRemoveTag(tag)}
                    >
                      {tag}
                      <X className="h-3 w-3 ml-1" />
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Version */}
            <div className="space-y-2">
              <Label htmlFor="export-version">Version</Label>
              <div className="flex gap-2">
                <Input
                  id="export-version"
                  value={manifest.version || ''}
                  onChange={(e) => setManifest((prev) => ({ ...prev, version: e.target.value }))}
                  placeholder="1.0.0"
                  className="font-mono text-sm flex-1"
                />
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setManifest((prev) => ({
                        ...prev,
                        version: suggestedVersions.patch,
                      }))
                    }
                    title="Bump patch version"
                  >
                    Patch
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setManifest((prev) => ({
                        ...prev,
                        version: suggestedVersions.minor,
                      }))
                    }
                    title="Bump minor version"
                  >
                    Minor
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setManifest((prev) => ({
                        ...prev,
                        version: suggestedVersions.major,
                      }))
                    }
                    title="Bump major version"
                  >
                    Major
                  </Button>
                </div>
              </div>
              {existingManifest?.version && (
                <p className="text-xs text-muted-foreground">
                  Current version: {existingManifest.version}
                </p>
              )}
            </div>

            {/* Changelog */}
            <div className="space-y-2">
              <Label htmlFor="export-changelog">Changelog</Label>
              <Textarea
                id="export-changelog"
                value={manifest.changelog || ''}
                onChange={(e) => setManifest((prev) => ({ ...prev, changelog: e.target.value }))}
                placeholder="What changed in this version?"
                rows={2}
              />
            </div>

            {/* Author Name */}
            <div className="space-y-2">
              <Label htmlFor="export-author">Author</Label>
              <Input
                id="export-author"
                value={manifest.authorName || ''}
                onChange={(e) => setManifest((prev) => ({ ...prev, authorName: e.target.value }))}
                placeholder="Your name or organization"
              />
            </div>

            {/* Min Devchain Version */}
            <div className="space-y-2">
              <Label htmlFor="export-min-version">Min Devchain Version</Label>
              <Input
                id="export-min-version"
                value={manifest.minDevchainVersion || ''}
                onChange={(e) =>
                  setManifest((prev) => ({ ...prev, minDevchainVersion: e.target.value }))
                }
                placeholder="0.4.0"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Minimum Devchain version required to use this template
              </p>
              {manifest.minDevchainVersion && !isValidSemVer(manifest.minDevchainVersion) && (
                <p className="text-xs text-destructive">
                  Invalid version format. Use semantic versioning (e.g., 0.4.0)
                </p>
              )}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isExporting}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !isMinVersionValid}>
            {isExporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
