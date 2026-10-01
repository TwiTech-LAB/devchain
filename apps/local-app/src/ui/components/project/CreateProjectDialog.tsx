import type { FormEvent } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { Textarea } from '@/ui/components/ui/textarea';

import type {
  CreateProjectFilePathValidation,
  CreateProjectFormData,
  ProjectPathValidation,
} from '@/ui/pages/projects/projects-page-presentation';
import type { ProjectWorkspace } from '@/ui/pages/projects/lib/project-contracts';

type TemplateSource = 'bundled' | 'registry' | 'file';

export interface CreateProjectTemplate {
  slug: string;
  name: string;
  source: TemplateSource;
}

export type { CreateProjectFilePathValidation, CreateProjectFormData };
export type CreateProjectPathValidation = ProjectPathValidation;

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  templateSourceTab: 'template' | 'file';
  onTemplateSourceTabChange: (value: 'template' | 'file') => void;
  templateFormData: CreateProjectFormData;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onVersionChange: (value: string) => void;
  workspaces?: ProjectWorkspace[];
  showWorkspaceSelector?: boolean;
  onWorkspaceChange?: (workspaceId: string) => void;
  templates?: CreateProjectTemplate[];
  selectedTemplateSource?: TemplateSource;
  sortedVersions: string[];
  onTemplateChange: (slug: string) => void;
  onTemplatePathChange: (path: string) => Promise<void> | void;
  onTemplateFilePathChange: (path: string) => Promise<void> | void;
  templatePathValidation: CreateProjectPathValidation;
  templateFilePathValidation: CreateProjectFilePathValidation;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  templateSourceTab,
  onTemplateSourceTabChange,
  templateFormData,
  onNameChange,
  onDescriptionChange,
  onVersionChange,
  workspaces = [],
  showWorkspaceSelector = false,
  onWorkspaceChange,
  templates,
  selectedTemplateSource,
  sortedVersions,
  onTemplateChange,
  onTemplatePathChange,
  onTemplateFilePathChange,
  templatePathValidation,
  templateFilePathValidation,
  onCancel,
  isSubmitting,
}: CreateProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Create a new project from a predefined template with prompts, profiles, agents, and
            statuses
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Tabs
            value={templateSourceTab}
            onValueChange={(value) => onTemplateSourceTabChange(value as 'template' | 'file')}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="template">From Template</TabsTrigger>
              <TabsTrigger value="file">From File</TabsTrigger>
            </TabsList>

            <TabsContent value="template" className="space-y-4 mt-4">
              <div>
                <Label htmlFor="template">Template *</Label>
                <Select
                  value={templateFormData.templateId}
                  onValueChange={onTemplateChange}
                  required
                >
                  <SelectTrigger id="template">
                    <SelectValue placeholder="Select a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates?.map((template) => (
                      <SelectItem key={template.slug} value={template.slug}>
                        <span className="flex items-center gap-2">
                          {template.name}
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              template.source === 'bundled'
                                ? 'text-muted-foreground'
                                : 'text-status-info border-status-info/40'
                            }`}
                          >
                            {template.source === 'bundled' ? 'Built-in' : 'Downloaded'}
                          </Badge>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedTemplateSource === 'registry' && sortedVersions.length > 0 && (
                <div>
                  <Label htmlFor="template-version">Version</Label>
                  <Select value={templateFormData.version} onValueChange={onVersionChange}>
                    <SelectTrigger id="template-version">
                      <SelectValue placeholder="Select a version" />
                    </SelectTrigger>
                    <SelectContent>
                      {sortedVersions.map((version, index) => (
                        <SelectItem key={version} value={version}>
                          {version}
                          {index === 0 && ' (latest)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </TabsContent>

            <TabsContent value="file" className="space-y-4 mt-4">
              <div>
                <Label htmlFor="templateFilePath">Template File Path *</Label>
                <Input
                  id="templateFilePath"
                  type="text"
                  value={templateFormData.templatePath}
                  onChange={(event) => onTemplateFilePathChange(event.target.value)}
                  required={templateSourceTab === 'file'}
                  placeholder="/absolute/path/to/template.json"
                  className="font-mono text-sm"
                />
                {templateFilePathValidation.checked && (
                  <div className="mt-2 space-y-2">
                    {!templateFilePathValidation.isAbsolute && (
                      <Alert variant="destructive">
                        <XCircle className="h-4 w-4" />
                        <AlertDescription>
                          Path must be absolute (start with / or drive letter)
                        </AlertDescription>
                      </Alert>
                    )}
                    {templateFilePathValidation.isAbsolute &&
                      !templateFilePathValidation.exists && (
                        <Alert variant="warn">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>File does not exist</AlertDescription>
                        </Alert>
                      )}
                    {templateFilePathValidation.exists && !templateFilePathValidation.isFile && (
                      <Alert variant="destructive">
                        <XCircle className="h-4 w-4" />
                        <AlertDescription>Path must be a file, not a directory</AlertDescription>
                      </Alert>
                    )}
                    {templateFilePathValidation.exists && templateFilePathValidation.isFile && (
                      <Alert variant="ok">
                        <CheckCircle2 className="h-4 w-4" />
                        <AlertDescription>Valid template file</AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  Enter the absolute path to a JSON template file
                </p>
              </div>
            </TabsContent>
          </Tabs>

          <div>
            <Label htmlFor="template-name">Name *</Label>
            <Input
              id="template-name"
              type="text"
              value={templateFormData.name}
              onChange={(event) => onNameChange(event.target.value)}
              required
              placeholder="My Project"
            />
          </div>

          <div>
            <Label htmlFor="template-rootPath">Root Path *</Label>
            <Input
              id="template-rootPath"
              type="text"
              value={templateFormData.rootPath}
              onChange={(event) => onTemplatePathChange(event.target.value)}
              required
              placeholder="/absolute/path/to/project"
              className={`font-mono text-sm ${
                !templatePathValidation.isAbsolute && templateFormData.rootPath
                  ? 'border-destructive'
                  : templatePathValidation.checked && !templatePathValidation.exists
                    ? 'border-status-warn/40'
                    : ''
              }`}
            />
            {!templatePathValidation.isAbsolute && templateFormData.rootPath && (
              <Alert variant="destructive" className="mt-2">
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  Path must be absolute (start with / or drive letter)
                </AlertDescription>
              </Alert>
            )}
            {templatePathValidation.isAbsolute &&
              templatePathValidation.checked &&
              !templatePathValidation.exists && (
                <Alert variant="warn" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>Warning: Path does not exist on filesystem</AlertDescription>
                </Alert>
              )}
            {templatePathValidation.isAbsolute &&
              templatePathValidation.checked &&
              templatePathValidation.exists && (
                <Alert variant="ok" className="mt-2">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertDescription>Path exists and is accessible</AlertDescription>
                </Alert>
              )}
          </div>

          <div>
            <Label htmlFor="template-description">Description</Label>
            <Textarea
              id="template-description"
              value={templateFormData.description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="Optional project description"
              rows={3}
            />
          </div>

          {showWorkspaceSelector && (
            <div>
              <Label htmlFor="create-project-workspace">Workspace</Label>
              <Select value={templateFormData.workspaceId} onValueChange={onWorkspaceChange}>
                <SelectTrigger id="create-project-workspace">
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
