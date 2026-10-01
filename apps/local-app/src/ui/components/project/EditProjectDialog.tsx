import type { FormEvent } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import type {
  EditProjectFormData,
  ProjectPathValidation,
} from '@/ui/pages/projects/projects-page-presentation';

export type { EditProjectFormData };
export type EditProjectPathValidation = ProjectPathValidation;

interface EditProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formData: EditProjectFormData;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onIsTemplateChange: (value: boolean) => void;
  pathValidation: EditProjectPathValidation;
  onPathChange: (path: string) => Promise<void> | void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function EditProjectDialog({
  open,
  onOpenChange,
  formData,
  onNameChange,
  onDescriptionChange,
  onIsTemplateChange,
  pathValidation,
  onPathChange,
  onSubmit,
  onCancel,
  isSubmitting,
}: EditProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
          <DialogDescription>Update the project details</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              name="name"
              type="text"
              autoComplete="off"
              value={formData.name}
              onChange={(e) => onNameChange(e.target.value)}
              required
              placeholder="My Project"
            />
          </div>

          <div>
            <Label htmlFor="rootPath">Root Path *</Label>
            <Input
              id="rootPath"
              name="rootPath"
              type="text"
              autoComplete="off"
              value={formData.rootPath}
              onChange={(e) => onPathChange(e.target.value)}
              required
              placeholder="/absolute/path/to/project"
              className={`font-mono text-sm ${
                !pathValidation.isAbsolute && formData.rootPath
                  ? 'border-destructive'
                  : pathValidation.checked && !pathValidation.exists
                    ? 'border-status-warn/40'
                    : ''
              }`}
            />
            {!pathValidation.isAbsolute && formData.rootPath && (
              <Alert variant="destructive" className="mt-2">
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  Path must be absolute (start with / or drive letter)
                </AlertDescription>
              </Alert>
            )}
            {pathValidation.isAbsolute && pathValidation.checked && !pathValidation.exists && (
              <Alert variant="warn" className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>Warning: Path does not exist on filesystem</AlertDescription>
              </Alert>
            )}
            {pathValidation.isAbsolute && pathValidation.checked && pathValidation.exists && (
              <Alert variant="ok" className="mt-2">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>Path exists and is accessible</AlertDescription>
              </Alert>
            )}
          </div>

          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Optional project description"
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="isTemplate"
              name="isTemplate"
              checked={!!formData.isTemplate}
              onCheckedChange={(checked) => onIsTemplateChange(Boolean(checked))}
            />
            <Label htmlFor="isTemplate">Mark as template</Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
