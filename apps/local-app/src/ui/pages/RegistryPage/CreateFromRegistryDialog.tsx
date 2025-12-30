import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, FolderPlus, AlertCircle } from 'lucide-react';

interface CreateFromRegistryDialogProps {
  slug: string;
  version: string;
  templateName: string;
  open: boolean;
  onClose: () => void;
}

interface CreateProjectInput {
  slug: string;
  version: string;
  projectName: string;
  projectDescription?: string;
  rootPath: string;
}

interface CreateProjectResult {
  project: {
    id: string;
    name: string;
    rootPath: string;
  };
  fromRegistry: boolean;
  templateSlug: string;
  templateVersion: string;
}

async function createProjectFromRegistry(input: CreateProjectInput): Promise<CreateProjectResult> {
  const res = await fetch('/api/registry/create-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create project' }));
    throw new Error(error.message || 'Failed to create project');
  }

  return res.json();
}

export function CreateFromRegistryDialog({
  slug,
  version,
  templateName,
  open,
  onClose,
}: CreateFromRegistryDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: createProjectFromRegistry,
    onSuccess: (result) => {
      toast({
        title: 'Project Created',
        description: `${result.project.name} created from ${templateName}`,
      });

      // Invalidate projects query to refresh list
      queryClient.invalidateQueries({ queryKey: ['projects'] });

      // Close dialog and navigate to projects
      onClose();
      navigate('/projects');
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = () => {
    setError(null);

    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }

    if (!rootPath.trim()) {
      setError('Root path is required');
      return;
    }

    createMutation.mutate({
      slug,
      version,
      projectName: projectName.trim(),
      projectDescription: projectDescription.trim() || undefined,
      rootPath: rootPath.trim(),
    });
  };

  const handleClose = () => {
    if (!createMutation.isPending) {
      setProjectName('');
      setProjectDescription('');
      setRootPath('');
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="h-5 w-5" />
            Create Project from Template
          </DialogTitle>
          <DialogDescription>
            Using <span className="font-medium">{templateName}</span> v{version}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="projectName">Project Name</Label>
            <Input
              id="projectName"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="My New Project"
              disabled={createMutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="projectDescription">Description (optional)</Label>
            <Textarea
              id="projectDescription"
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="A brief description of your project"
              rows={2}
              disabled={createMutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="rootPath">Root Path</Label>
            <Input
              id="rootPath"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/path/to/project"
              disabled={createMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              The directory where your project files are located
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!projectName.trim() || !rootPath.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Project'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
