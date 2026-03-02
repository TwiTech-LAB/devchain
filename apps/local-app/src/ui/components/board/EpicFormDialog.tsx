import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { Epic } from './types';

export interface EpicFormData {
  title: string;
  description: string;
  tags: string;
  parentId: string;
}

export interface EpicFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingEpic: Epic | null;
  activeProjectName?: string;
  formData: EpicFormData;
  onFormDataChange: (data: EpicFormData) => void;
  parentCandidates: Epic[];
  hasParentFilter: boolean;
  activeParent: Epic | null;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function EpicFormDialog({
  open,
  onOpenChange,
  editingEpic,
  activeProjectName,
  formData,
  onFormDataChange,
  parentCandidates,
  hasParentFilter,
  activeParent,
  onSubmit,
  onCancel,
  isSubmitting,
}: EpicFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingEpic ? 'Edit Epic' : 'Create Epic'}</DialogTitle>
          <DialogDescription>
            {editingEpic
              ? 'Update the epic details'
              : `Create a new epic for ${activeProjectName ?? 'this project'}`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="epic-title">Title *</Label>
            <Input
              id="epic-title"
              type="text"
              value={formData.title}
              onChange={(e) => onFormDataChange({ ...formData, title: e.target.value })}
              required
              placeholder="Enter epic title"
            />
          </div>

          <div>
            <Label htmlFor="epic-description">Description</Label>
            <Textarea
              id="epic-description"
              value={formData.description}
              onChange={(e) => onFormDataChange({ ...formData, description: e.target.value })}
              placeholder="Optional description"
              rows={3}
            />
          </div>

          <div>
            <Label htmlFor="epic-tags">Tags</Label>
            <Input
              id="epic-tags"
              type="text"
              value={formData.tags}
              onChange={(e) => onFormDataChange({ ...formData, tags: e.target.value })}
              placeholder="tag1, tag2, tag3"
            />
            <p className="text-xs text-muted-foreground mt-1">Separate tags with commas</p>
          </div>

          {parentCandidates.length > 0 && (hasParentFilter || formData.parentId !== 'none') && (
            <div>
              <Label htmlFor="epic-parent">Parent</Label>
              <Select
                value={formData.parentId}
                onValueChange={(value) => onFormDataChange({ ...formData, parentId: value })}
              >
                <SelectTrigger id="epic-parent">
                  <SelectValue placeholder="Select parent epic" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No parent</SelectItem>
                  {parentCandidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeParent && (
                <p className="text-xs text-muted-foreground mt-1">
                  Prefilled with{' '}
                  <span className="font-medium text-foreground">{activeParent.title}</span>
                  {' from the current filter.'}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {editingEpic ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
