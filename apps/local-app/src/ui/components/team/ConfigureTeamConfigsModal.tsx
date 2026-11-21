import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
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
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { providerConfigQueries } from '@/ui/lib/provider-configs';
import { ProviderConfigGranularSelector } from './ProviderConfigGranularSelector';
import { toConfigItem, type ConfigItem, type ProfileSelection } from './selector-types';

interface ConfigureTeamConfigsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: Array<{ id: string; name: string }>;
  linkedProfileIds: string[];
  selections: Array<{ profileId: string; configIds: string[] }>;
  presetConfigs?: Record<string, ConfigItem<string>[]>;
  onSave: (result: {
    profileIds: string[];
    profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
  }) => void;
}

export function ConfigureTeamConfigsModal({
  open,
  onOpenChange,
  profiles,
  linkedProfileIds,
  selections,
  presetConfigs,
  onSave,
}: ConfigureTeamConfigsModalProps) {
  const fetchFn = useFetchFactory();
  const [workingSelections, setWorkingSelections] = useState<
    Array<ProfileSelection<string, string>>
  >([]);
  const [focusedProfileId, setFocusedProfileId] = useState<string | null>(null);
  const wasOpen = useRef(false);

  // Load the saved selections only as the window opens. A parent re-render passes new
  // arrays, and reloading on it would discard the ticks the user has not saved.
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const initial: Array<ProfileSelection<string, string>> = linkedProfileIds.map((pid) => {
      const sel = selections.find((s) => s.profileId === pid);
      if (!sel || sel.configIds.length === 0) {
        return { profileKey: pid, mode: 'allow-all' as const };
      }
      return { profileKey: pid, mode: 'subset' as const, configKeys: [...sel.configIds] };
    });
    setWorkingSelections(initial);
    setFocusedProfileId(profiles.length > 0 ? profiles[0].id : null);
  }, [open, selections, profiles, linkedProfileIds]);

  const {
    data: configsData,
    isLoading: configsLoading,
    isError: configsError,
    refetch: configsRefetch,
  } = useQuery({
    ...providerConfigQueries.profile(fetchFn, focusedProfileId),
    enabled: !presetConfigs && !!focusedProfileId,
  });

  const configsByProfile = useMemo(() => {
    if (!focusedProfileId || !configsData) return {} as Record<string, ConfigItem<string>[]>;
    return {
      [focusedProfileId]: configsData.map(toConfigItem),
    } as Record<string, ConfigItem<string>[]>;
  }, [focusedProfileId, configsData]);

  const hasEmptySelection =
    !!presetConfigs &&
    (workingSelections.length !== linkedProfileIds.length ||
      workingSelections.some((selection) => {
        const options = presetConfigs[selection.profileKey] ?? [];
        return !options.some(
          ({ key }) => selection.mode === 'allow-all' || selection.configKeys?.includes(key),
        );
      }));

  function handleSave() {
    if (hasEmptySelection) return;

    const profileIds: string[] = [];
    const profileConfigSelections: Array<{ profileId: string; configIds: string[] }> = [];

    for (const sel of workingSelections) {
      if (sel.mode === 'remove') continue;
      profileIds.push(sel.profileKey);
      if (sel.mode === 'subset' && sel.configKeys && sel.configKeys.length > 0) {
        profileConfigSelections.push({ profileId: sel.profileKey, configIds: sel.configKeys });
      }
    }

    onSave({ profileIds, profileConfigSelections });
    onOpenChange(false);
  }

  function getBadgeText(profileId: string): string {
    const sel = workingSelections.find((s) => s.profileKey === profileId);
    if (!sel || sel.mode === 'allow-all') return 'All';
    if (sel.mode === 'remove') return 'Removed';
    return `${sel.configKeys?.length ?? 0} selected`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[800px]">
        <DialogHeader>
          <DialogTitle>Configure Allowed Configs</DialogTitle>
          <DialogDescription>
            Select which providers each profile can use in this team.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4" style={{ minHeight: 320 }}>
          {/* Left pane: profile list */}
          <div className="w-1/3 shrink-0">
            <ScrollArea className="h-[320px] rounded-md border">
              <div className="flex flex-col p-1">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => setFocusedProfileId(profile.id)}
                    className={`flex items-center justify-between rounded px-2 py-2 text-left text-sm ${
                      focusedProfileId === profile.id
                        ? 'bg-selected text-selected-foreground'
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="truncate">{profile.name}</span>
                    <Badge variant="secondary" className="ml-2 shrink-0 text-xs">
                      {getBadgeText(profile.id)}
                    </Badge>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right pane: provider-grouped configs */}
          <div className="flex flex-1 flex-col gap-3">
            {!presetConfigs && configsLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !presetConfigs && configsError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <p className="text-sm text-muted-foreground">Failed to load configs</p>
                <Button type="button" variant="outline" size="sm" onClick={() => configsRefetch()}>
                  Retry
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-[320px]">
                <ProviderConfigGranularSelector
                  focusedProfileKey={focusedProfileId}
                  configsByProfile={presetConfigs ?? configsByProfile}
                  selections={workingSelections}
                  onChange={setWorkingSelections}
                  allowProfileRemoval={!presetConfigs}
                />
              </ScrollArea>
            )}
          </div>
        </div>

        {hasEmptySelection && (
          <p className="text-sm text-destructive" role="status">
            Select at least one config for each profile.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={hasEmptySelection}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
