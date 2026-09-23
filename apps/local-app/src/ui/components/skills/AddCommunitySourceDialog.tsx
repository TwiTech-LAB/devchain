import { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import type { ExistingProjectsChoice } from '@/ui/lib/skills';

type AddSourceType = 'community' | 'local';
type ExistingProjectsOption = 'none' | 'current-project' | 'all';

interface AddCommunitySourceDialogSubmitCommunity {
  type: 'community';
  name: string;
  url: string;
  branch: string;
  existingProjects: ExistingProjectsChoice;
}

interface AddCommunitySourceDialogSubmitLocal {
  type: 'local';
  name: string;
  folderPath: string;
  existingProjects: ExistingProjectsChoice;
}

export type AddCommunitySourceDialogSubmit =
  | AddCommunitySourceDialogSubmitCommunity
  | AddCommunitySourceDialogSubmitLocal;

interface AddCommunitySourceDialogProps {
  open: boolean;
  isSubmitting: boolean;
  currentProject: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: AddCommunitySourceDialogSubmit) => Promise<void>;
}

function suggestNameFromGitHubUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url.trim());
    const host = parsedUrl.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      return null;
    }

    const segments = parsedUrl.pathname.split('/').filter((segment) => segment.length > 0);
    const repoSegment = segments[1];
    if (!repoSegment) {
      return null;
    }

    return repoSegment.replace(/\.git$/i, '').toLowerCase();
  } catch {
    return null;
  }
}

function suggestNameFromFolderPath(folderPath: string): string | null {
  const trimmedPath = folderPath.trim().replace(/[\\/]+$/, '');
  if (!trimmedPath) {
    return null;
  }

  const pathSegments = trimmedPath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const folderName = pathSegments[pathSegments.length - 1];
  if (!folderName) {
    return null;
  }

  const normalized = folderName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : null;
}

function toExistingProjectsChoice(
  option: ExistingProjectsOption,
  currentProject: { id: string } | null,
): ExistingProjectsChoice {
  if (option === 'all') {
    return { mode: 'all' };
  }
  if (option === 'current-project' && currentProject) {
    return { mode: 'selected', projectIds: [currentProject.id] };
  }
  return { mode: 'none' };
}

export function AddCommunitySourceDialog({
  open,
  isSubmitting,
  currentProject,
  onOpenChange,
  onSubmit,
}: AddCommunitySourceDialogProps) {
  const [sourceType, setSourceType] = useState<AddSourceType>('community');
  const [url, setUrl] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [nameEdited, setNameEdited] = useState(false);
  const [existingProjectsOption, setExistingProjectsOption] =
    useState<ExistingProjectsOption>('none');
  const [error, setError] = useState<string | null>(null);

  const existingProjectsOptions: Array<{ value: ExistingProjectsOption; label: string }> = [
    { value: 'none', label: 'Keep disabled' },
    ...(currentProject
      ? [{ value: 'current-project' as const, label: `Enable in ${currentProject.name}` }]
      : []),
    { value: 'all', label: 'Enable in all existing projects (all workspaces in this instance)' },
  ];

  useEffect(() => {
    if (open) {
      return;
    }

    setSourceType('community');
    setUrl('');
    setFolderPath('');
    setName('');
    setBranch('main');
    setNameEdited(false);
    setExistingProjectsOption('none');
    setError(null);
  }, [open]);

  const setSourceTypeAndSuggestName = (nextSourceType: AddSourceType) => {
    setSourceType(nextSourceType);
    setNameEdited(false);
    setError(null);
    const suggestedName =
      nextSourceType === 'community'
        ? suggestNameFromGitHubUrl(url)
        : suggestNameFromFolderPath(folderPath);
    setName(suggestedName ?? '');
  };

  const handleSubmit = async () => {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) {
      setError('Source name is required.');
      return;
    }

    const normalizedUrl = url.trim();
    const normalizedFolderPath = folderPath.trim();
    const normalizedBranch = branch.trim() || 'main';

    if (sourceType === 'community' && !normalizedUrl) {
      setError('GitHub URL is required.');
      return;
    }

    if (sourceType === 'local' && !normalizedFolderPath) {
      setError('Folder path is required.');
      return;
    }

    setError(null);
    try {
      const existingProjects = toExistingProjectsChoice(existingProjectsOption, currentProject);

      if (sourceType === 'community') {
        await onSubmit({
          type: 'community',
          name: normalizedName,
          url: normalizedUrl,
          branch: normalizedBranch,
          existingProjects,
        });
      } else {
        await onSubmit({
          type: 'local',
          name: normalizedName,
          folderPath: normalizedFolderPath,
          existingProjects,
        });
      }
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to add source.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isSubmitting && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add Source
          </DialogTitle>
          <DialogDescription>
            {sourceType === 'community' ? (
              <>
                Add a GitHub repository that follows the <code>skills/&lt;name&gt;/SKILL.md</code>{' '}
                convention.
              </>
            ) : (
              <>
                Add a local folder path that includes a <code>skills/</code> directory containing
                skill definitions.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Tabs
            value={sourceType}
            onValueChange={(nextValue) => {
              if (nextValue === 'community' || nextValue === 'local') {
                setSourceTypeAndSuggestName(nextValue);
              }
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="community" disabled={isSubmitting}>
                GitHub Repository
              </TabsTrigger>
              <TabsTrigger value="local" disabled={isSubmitting}>
                Local Folder
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {sourceType === 'community' ? (
            <div className="space-y-2">
              <Label htmlFor="community-source-url">GitHub URL</Label>
              <Input
                id="community-source-url"
                placeholder="https://github.com/owner/repo"
                value={url}
                disabled={isSubmitting}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  setUrl(nextUrl);
                  if (!nameEdited) {
                    const suggestedName = suggestNameFromGitHubUrl(nextUrl);
                    if (suggestedName) {
                      setName(suggestedName);
                    }
                  }
                }}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="local-source-folder-path">Folder Path</Label>
              <Input
                id="local-source-folder-path"
                placeholder="/absolute/path/to/source"
                value={folderPath}
                disabled={isSubmitting}
                onChange={(event) => {
                  const nextFolderPath = event.target.value;
                  setFolderPath(nextFolderPath);
                  if (!nameEdited) {
                    const suggestedName = suggestNameFromFolderPath(nextFolderPath);
                    if (suggestedName) {
                      setName(suggestedName);
                    }
                  }
                }}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="source-name">Source Name</Label>
            <Input
              id="source-name"
              placeholder={sourceType === 'community' ? 'repo-name' : 'local-source'}
              value={name}
              disabled={isSubmitting}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
          </div>

          {sourceType === 'community' ? (
            <div className="space-y-2">
              <Label htmlFor="community-source-branch">Branch</Label>
              <Input
                id="community-source-branch"
                placeholder="main"
                value={branch}
                disabled={isSubmitting}
                onChange={(event) => setBranch(event.target.value)}
              />
            </div>
          ) : null}

          <fieldset className="space-y-2" disabled={isSubmitting}>
            <legend className="text-sm font-medium">Existing projects</legend>
            <div className="space-y-1.5">
              {existingProjectsOptions.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="existing-projects"
                    value={option.value}
                    className="h-4 w-4 accent-foreground"
                    checked={existingProjectsOption === option.value}
                    onChange={() => setExistingProjectsOption(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Adding...
              </>
            ) : (
              'Add Source'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
