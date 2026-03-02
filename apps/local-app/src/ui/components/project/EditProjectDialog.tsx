import type { Dispatch, FormEvent, SetStateAction } from 'react';
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

export interface EditProjectFormData {
  name: string;
  description: string;
  rootPath: string;
  isTemplate: boolean;
}

export interface EditProjectPathValidation {
  isAbsolute: boolean;
  exists: boolean;
  checked: boolean;
}

interface EditProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formData: EditProjectFormData;
  setFormData: Dispatch<SetStateAction<EditProjectFormData>>;
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
  setFormData,
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
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              placeholder="My Project"
            />
          </div>

          <div>
            <Label htmlFor="rootPath">Root Path *</Label>
            <Input
              id="rootPath"
              type="text"
              value={formData.rootPath}
              onChange={(e) => onPathChange(e.target.value)}
              required
              placeholder="/absolute/path/to/project"
              className={`font-mono text-sm ${
                !pathValidation.isAbsolute && formData.rootPath
                  ? 'border-destructive'
                  : pathValidation.checked && !pathValidation.exists
                    ? 'border-yellow-600'
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
              <Alert className="mt-2 border-yellow-600">
                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-600">
                  Warning: Path does not exist on filesystem
                </AlertDescription>
              </Alert>
            )}
            {pathValidation.isAbsolute && pathValidation.checked && pathValidation.exists && (
              <Alert className="mt-2 border-green-600">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-600">
                  Path exists and is accessible
                </AlertDescription>
              </Alert>
            )}
          </div>

          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Optional project description"
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="isTemplate"
              checked={!!formData.isTemplate}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, isTemplate: Boolean(checked) })
              }
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
