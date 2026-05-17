import { useState, useEffect } from 'react';
import { Loader2, Info } from 'lucide-react';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useToast } from '@/ui/hooks/use-toast';
import {
  createScheduledEpic,
  updateScheduledEpic,
  type ScheduledEpic,
  type CronPreset,
  type CreateScheduledEpicData,
} from '@/ui/lib/schedules';

interface ScheduleDialogProps {
  open: boolean;
  onClose: (success?: boolean) => void;
  schedule: ScheduledEpic | null;
  projectId: string;
  presets: CronPreset[];
}

export function ScheduleDialog({ open, onClose, schedule, projectId, presets }: ScheduleDialogProps) {
  const { toast } = useToast();
  const isEditing = !!schedule;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [useCustomCron, setUseCustomCron] = useState(false);
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState('');

  useEffect(() => {
    if (schedule) {
      setName(schedule.name);
      setDescription(schedule.description ?? '');
      setTemplateTitle(schedule.templateTitle);
      setTemplateDescription(schedule.templateDescription ?? '');
      setMaxOccurrences(schedule.maxOccurrences?.toString() ?? '');

      const presetMatch = presets.find((p) => p.cronExpression === schedule.cronExpression);
      if (presetMatch) {
        setCronExpression(schedule.cronExpression);
        setCustomCron('');
        setUseCustomCron(false);
      } else {
        setCronExpression('custom');
        setCustomCron(schedule.cronExpression);
        setUseCustomCron(true);
      }
    } else {
      setName('');
      setDescription('');
      setCronExpression('');
      setCustomCron('');
      setUseCustomCron(false);
      setTemplateTitle('');
      setTemplateDescription('');
      setMaxOccurrences('');
    }
  }, [schedule, presets, open]);

  const activeCron = useCustomCron ? customCron : cronExpression;

  const handleSave = async () => {
    if (!name.trim() || !activeCron.trim() || !templateTitle.trim()) return;

    try {
      const data: {
        name: string;
        description: string | null;
        cronExpression: string;
        templateTitle: string;
        templateDescription: string | null;
        maxOccurrences: number | null;
      } = {
        name: name.trim(),
        description: description.trim() || null,
        cronExpression: activeCron.trim(),
        templateTitle: templateTitle.trim(),
        templateDescription: templateDescription.trim() || null,
        maxOccurrences: maxOccurrences ? parseInt(maxOccurrences, 10) : null,
      };

      if (isEditing && schedule) {
        await updateScheduledEpic(schedule.id, data);
        toast({ title: 'Schedule updated' });
      } else {
        const createData: CreateScheduledEpicData = {
          projectId,
          name: data.name,
          description: data.description,
          enabled: true,
          cronExpression: data.cronExpression,
          templateTitle: data.templateTitle,
          templateDescription: data.templateDescription,
          maxOccurrences: data.maxOccurrences,
        };
        await createScheduledEpic(createData);
        toast({ title: 'Schedule created' });
      }
      onClose(true);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save schedule',
        variant: 'destructive',
      });
    }
  };

  const isValid = name.trim() && activeCron.trim() && templateTitle.trim();

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Schedule' : 'Create Schedule'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the recurring epic schedule'
              : 'Set up a recurring epic that will be created automatically on a schedule'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily standup epic"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-description">Description</Label>
            <Input
              id="schedule-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>

          <div className="space-y-2">
            <Label>Schedule</Label>
            <div className="flex gap-2">
              <Select
                value={useCustomCron ? 'custom' : cronExpression}
                onValueChange={(val) => {
                  if (val === 'custom') {
                    setUseCustomCron(true);
                  } else {
                    setUseCustomCron(false);
                    setCronExpression(val);
                  }
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select interval" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.cronExpression} value={preset.cronExpression}>
                      {preset.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom cron...</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {useCustomCron && (
              <Input
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="0 */6 * * *"
                className="font-mono text-sm"
              />
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="template-title">Epic Title Template</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {"Use {{date}}, {{time}}, {{sequence}}, {{datetime}} for dynamic values"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Input
              id="template-title"
              value={templateTitle}
              onChange={(e) => setTemplateTitle(e.target.value)}
              placeholder="e.g., Daily standup - {{date}}"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="template-description">Epic Description Template</Label>
            <Textarea
              id="template-description"
              value={templateDescription}
              onChange={(e) => setTemplateDescription(e.target.value)}
              placeholder="Optional epic description (supports {{date}}, {{sequence}})"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-occurrences">Max Occurrences</Label>
            <Input
              id="max-occurrences"
              type="number"
              min="1"
              value={maxOccurrences}
              onChange={(e) => setMaxOccurrences(e.target.value)}
              placeholder="Unlimited"
            />
            <p className="text-xs text-muted-foreground">
              Auto-disable after this many executions (leave empty for unlimited)
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid}>
            {isEditing ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
