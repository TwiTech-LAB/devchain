import { useEffect, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { useSettingsData } from './useSettingsData';

const DEFAULT_EPIC_ASSIGNED_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. (Epic ID: {epic_id})';

const EPIC_ASSIGNED_PLACEHOLDERS = [
  { token: '{epic_id}', description: 'Epic UUID' },
  { token: '{agent_name}', description: 'Agent display name' },
  { token: '{epic_title}', description: 'Epic title' },
  { token: '{project_name}', description: 'Project name' },
  { token: '{assigner_name}', description: 'Who assigned the epic (or "System" if unknown)' },
];

export function EventsSection() {
  const { settings, updateEpicTemplateMutation } = useSettingsData();

  const serverEpicTemplate = settings?.events?.epicAssigned?.template ?? '';
  const [epicTemplateDraft, setEpicTemplateDraft] = useState('');

  useEffect(() => {
    setEpicTemplateDraft(serverEpicTemplate);
  }, [serverEpicTemplate]);

  const epicTemplateDirty = epicTemplateDraft !== serverEpicTemplate;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>Customize agent notifications triggered by events.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="epic-assigned-template">Epic Assigned message</Label>
            <Textarea
              id="epic-assigned-template"
              value={epicTemplateDraft}
              onChange={(event) => setEpicTemplateDraft(event.target.value)}
              placeholder={DEFAULT_EPIC_ASSIGNED_TEMPLATE}
              rows={5}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to use the default message. Supports the placeholders below.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => updateEpicTemplateMutation.mutate({ template: epicTemplateDraft })}
              disabled={!epicTemplateDirty || updateEpicTemplateMutation.isPending}
            >
              {updateEpicTemplateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEpicTemplateDraft(DEFAULT_EPIC_ASSIGNED_TEMPLATE)}
              disabled={updateEpicTemplateMutation.isPending}
            >
              Reset to default
            </Button>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-semibold mb-2">Available placeholders</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {EPIC_ASSIGNED_PLACEHOLDERS.map(({ token, description }) => (
                <li key={token}>
                  <code className="font-mono text-xs mr-2">{token}</code>
                  {description}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
