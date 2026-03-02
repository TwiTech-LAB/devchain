import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { Loader2 } from 'lucide-react';
import { useSettingsData } from './useSettingsData';

const DEFAULT_SKILLS_SYNC_ON_STARTUP = true;

export function SkillsSection() {
  const { settings, updateSkillsMutation } = useSettingsData();
  const [skillsSyncOnStartup, setSkillsSyncOnStartup] = useState(DEFAULT_SKILLS_SYNC_ON_STARTUP);

  useEffect(() => {
    if (!settings) return;
    setSkillsSyncOnStartup(settings.skills?.syncOnStartup ?? DEFAULT_SKILLS_SYNC_ON_STARTUP);
  }, [settings]);

  const handleChange = (checked: boolean) => {
    const previous = skillsSyncOnStartup;
    setSkillsSyncOnStartup(checked);
    updateSkillsMutation.mutate(
      { syncOnStartup: checked },
      { onError: () => setSkillsSyncOnStartup(previous) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>Configure startup behavior for skills synchronization.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 max-w-lg">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="skills-sync-on-startup">Sync skills on startup</Label>
              <p className="text-xs text-muted-foreground">
                Automatically refresh skills when the app starts.
              </p>
            </div>
            <Switch
              id="skills-sync-on-startup"
              checked={skillsSyncOnStartup}
              onCheckedChange={handleChange}
              disabled={updateSkillsMutation.isPending}
            />
          </div>

          {updateSkillsMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving settings…
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
