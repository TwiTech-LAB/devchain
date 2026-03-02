import { Loader2, Upload } from 'lucide-react';
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
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';

interface TemplateOption {
  slug: string;
  name: string;
  source: 'bundled' | 'registry' | 'file';
}

interface ImportSourceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importTargetName?: string;
  selectedTemplateId: string;
  onTemplateChange: (slug: string) => void;
  templates?: TemplateOption[];
  selectedImportTemplateSource?: 'bundled' | 'registry' | 'file';
  sortedImportVersions: string[];
  selectedImportVersion: string;
  onSelectedImportVersionChange: (version: string) => void;
  onImportFromTemplate: () => void;
  onImportFromFile: () => void;
  isImporting: boolean;
}

export function ImportSourceModal({
  open,
  onOpenChange,
  importTargetName,
  selectedTemplateId,
  onTemplateChange,
  templates,
  selectedImportTemplateSource,
  sortedImportVersions,
  selectedImportVersion,
  onSelectedImportVersionChange,
  onImportFromTemplate,
  onImportFromFile,
  isImporting,
}: ImportSourceModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Configuration</DialogTitle>
          <DialogDescription>
            Import configuration for &quot;{importTargetName}&quot; from a template or JSON file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>From Template</Label>
            <div className="flex flex-col gap-2">
              <Select value={selectedTemplateId} onValueChange={onTemplateChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template..." />
                </SelectTrigger>
                <SelectContent>
                  {templates?.map((t) => (
                    <SelectItem key={t.slug} value={t.slug}>
                      <span className="flex items-center gap-2">
                        {t.name}
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            t.source === 'bundled'
                              ? 'text-muted-foreground'
                              : 'text-blue-600 border-blue-600/50'
                          }`}
                        >
                          {t.source === 'bundled' ? 'Built-in' : 'Downloaded'}
                        </Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedImportTemplateSource === 'registry' && sortedImportVersions.length > 0 && (
                <Select value={selectedImportVersion} onValueChange={onSelectedImportVersionChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a version..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedImportVersions.map((version, index) => (
                      <SelectItem key={version} value={version}>
                        {version}
                        {index === 0 && ' (latest)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button onClick={onImportFromTemplate} disabled={!selectedTemplateId || isImporting}>
                {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Import'}
              </Button>
            </div>
          </div>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">Or</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>From File</Label>
            <Button variant="outline" className="w-full" onClick={onImportFromFile}>
              <Upload className="h-4 w-4 mr-2" />
              Select JSON File...
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
