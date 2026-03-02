import type { Dispatch, FormEvent, SetStateAction } from 'react';
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

type TemplateSource = 'bundled' | 'registry' | 'file';

export interface CreateProjectTemplate {
  slug: string;
  name: string;
  source: TemplateSource;
}

export interface CreateProjectFormData {
  name: string;
  description: string;
  rootPath: string;
  templateId: string;
  version: string;
  templatePath: string;
}

export interface CreateProjectPathValidation {
  isAbsolute: boolean;
  exists: boolean;
  checked: boolean;
}

export interface CreateProjectFilePathValidation extends CreateProjectPathValidation {
  isFile: boolean;
  error?: string;
}

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  templateSourceTab: 'template' | 'file';
  onTemplateSourceTabChange: (value: 'template' | 'file') => void;
  templateFormData: CreateProjectFormData;
  setTemplateFormData: Dispatch<SetStateAction<CreateProjectFormData>>;
  templates?: CreateProjectTemplate[];
  selectedTemplateSource?: TemplateSource;
  sortedVersions: string[];
  availablePresets: string[];
  selectedPreset: string;
  onSelectedPresetChange: (preset: string) => void;
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
  setTemplateFormData,
  templates,
  selectedTemplateSource,
  sortedVersions,
  availablePresets,
  selectedPreset,
  onSelectedPresetChange,
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
                                : 'text-blue-600 border-blue-600/50'
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
                  <Select
                    value={templateFormData.version}
                    onValueChange={(value) =>
                      setTemplateFormData((prev) => ({ ...prev, version: value }))
                    }
                  >
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

              {availablePresets.length > 0 && (
                <div>
                  <Label htmlFor="template-preset">Preset (Optional)</Label>
                  <Select
                    value={selectedPreset || '__none__'}
                    onValueChange={(value) =>
                      onSelectedPresetChange(value === '__none__' ? '' : value)
                    }
                  >
                    <SelectTrigger id="template-preset">
                      <SelectValue placeholder="Use default configuration" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Default configuration</SelectItem>
                      {availablePresets.map((presetName) => (
                        <SelectItem key={presetName} value={presetName}>
                          {presetName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Optionally select a preset to pre-configure agent providers
                  </p>
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
                        <Alert className="border-yellow-600">
                          <AlertTriangle className="h-4 w-4 text-yellow-600" />
                          <AlertDescription className="text-yellow-600">
                            File does not exist
                          </AlertDescription>
                        </Alert>
                      )}
                    {templateFilePathValidation.exists && !templateFilePathValidation.isFile && (
                      <Alert variant="destructive">
                        <XCircle className="h-4 w-4" />
                        <AlertDescription>Path must be a file, not a directory</AlertDescription>
                      </Alert>
                    )}
                    {templateFilePathValidation.exists && templateFilePathValidation.isFile && (
                      <Alert className="border-green-600">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <AlertDescription className="text-green-600">
                          Valid template file
                        </AlertDescription>
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
              onChange={(event) =>
                setTemplateFormData((prev) => ({ ...prev, name: event.target.value }))
              }
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
                    ? 'border-yellow-600'
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
                <Alert className="mt-2 border-yellow-600">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription className="text-yellow-600">
                    Warning: Path does not exist on filesystem
                  </AlertDescription>
                </Alert>
              )}
            {templatePathValidation.isAbsolute &&
              templatePathValidation.checked &&
              templatePathValidation.exists && (
                <Alert className="mt-2 border-green-600">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-600">
                    Path exists and is accessible
                  </AlertDescription>
                </Alert>
              )}
          </div>

          <div>
            <Label htmlFor="template-description">Description</Label>
            <Textarea
              id="template-description"
              value={templateFormData.description}
              onChange={(event) =>
                setTemplateFormData((prev) => ({ ...prev, description: event.target.value }))
              }
              placeholder="Optional project description"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
