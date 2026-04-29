import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';

interface ProviderConfigItem {
  id: string;
  name: string;
  description: string | null;
  profileId: string;
}

export interface QuickAddPayload {
  teamId: string;
  teamName: string;
  providerConfigId: string;
  profileId: string;
  profileName: string;
  computedName: string;
}

interface TeamQuickAddButtonProps {
  teamId: string;
  teamName: string;
  teamLeadAgentId: string | null;
  profileIds: string[];
  profilesById: Map<string, { id: string; name: string }>;
  agents: Array<{ name: string }>;
  onAddAgent: (payload: QuickAddPayload) => void;
}

export function computeAutoName(profileName: string, existingAgentNames: string[]): string {
  const escaped = profileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped} \\((\\d+)\\)$`, 'i');
  const usedNumbers = new Set<number>();
  for (const name of existingAgentNames) {
    const match = regex.exec(name);
    if (match) usedNumbers.add(parseInt(match[1], 10));
  }
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `${profileName} (${n})`;
}

export function TeamQuickAddButton({
  teamId,
  teamName,
  teamLeadAgentId,
  profileIds,
  profilesById,
  agents,
  onAddAgent,
}: TeamQuickAddButtonProps) {
  const [open, setOpen] = useState(false);

  const noProfiles = profileIds.length === 0;
  const noLead = teamLeadAgentId === null;
  const disabled = noProfiles || noLead;

  const configQueries = useQueries({
    queries: profileIds.map((profileId) => ({
      queryKey: ['profile-provider-configs', '', profileId] as const,
      queryFn: async () => {
        const res = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/provider-configs`);
        if (!res.ok) throw new Error('Failed to fetch configs');
        return res.json() as Promise<ProviderConfigItem[]>;
      },
      enabled: open && !disabled,
    })),
  });

  const isLoading = configQueries.some((q) => q.isLoading);
  const allLoaded = configQueries.every((q) => !q.isLoading);

  const groupedConfigs: Array<{
    profileId: string;
    profileName: string;
    configs: ProviderConfigItem[];
  }> = [];
  if (allLoaded) {
    for (let i = 0; i < profileIds.length; i++) {
      const profileId = profileIds[i];
      const configs = (configQueries[i]?.data ?? []) as ProviderConfigItem[];
      if (configs.length === 0) continue;
      const profile = profilesById.get(profileId);
      groupedConfigs.push({
        profileId,
        profileName: profile?.name ?? profileId,
        configs,
      });
    }
  }

  const hasNoConfigs = allLoaded && groupedConfigs.length === 0;

  function handleSelectConfig(config: ProviderConfigItem, profileName: string) {
    setOpen(false);
    const computedName = computeAutoName(
      profileName,
      agents.map((a) => a.name),
    );
    onAddAgent({
      teamId,
      teamName,
      providerConfigId: config.id,
      profileId: config.profileId,
      profileName,
      computedName,
    });
  }

  const tooltipText = noProfiles
    ? 'Link profiles to this team first'
    : noLead
      ? 'Assign a team lead first'
      : 'Add agent';

  const button = (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 w-6 p-0"
      disabled={disabled}
      aria-label={`Add agent to ${teamName}`}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Add agent</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent className="w-64 p-2" align="start">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : hasNoConfigs ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No provider configs available. Create one in Profiles first.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {groupedConfigs.map((group) => (
              <div key={group.profileId}>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.profileName}
                </p>
                {group.configs.map((config) => (
                  <button
                    key={config.id}
                    type="button"
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => handleSelectConfig(config, group.profileName)}
                  >
                    {config.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
