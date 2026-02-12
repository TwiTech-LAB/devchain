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

export interface AddCommunitySourceDialogSubmit {
  name: string;
  url: string;
  branch: string;
}

interface AddCommunitySourceDialogProps {
  open: boolean;
  isSubmitting: boolean;
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

export function AddCommunitySourceDialog({
  open,
  isSubmitting,
  onOpenChange,
  onSubmit,
}: AddCommunitySourceDialogProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [nameEdited, setNameEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      return;
    }

    setUrl('');
    setName('');
    setBranch('main');
    setNameEdited(false);
    setError(null);
  }, [open]);

  const handleSubmit = async () => {
    const normalizedUrl = url.trim();
    const normalizedName = name.trim().toLowerCase();
    const normalizedBranch = branch.trim() || 'main';

    if (!normalizedUrl) {
      setError('GitHub URL is required.');
      return;
    }
    if (!normalizedName) {
      setError('Source name is required.');
      return;
    }

    setError(null);
    try {
      await onSubmit({
        name: normalizedName,
        url: normalizedUrl,
        branch: normalizedBranch,
      });
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
            Add Community Source
          </DialogTitle>
          <DialogDescription>
            Add a GitHub repository that follows the <code>skills/&lt;name&gt;/SKILL.md</code>{' '}
            convention.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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

          <div className="space-y-2">
            <Label htmlFor="community-source-name">Source Name</Label>
            <Input
              id="community-source-name"
              placeholder="repo-name"
              value={name}
              disabled={isSubmitting}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
          </div>

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
