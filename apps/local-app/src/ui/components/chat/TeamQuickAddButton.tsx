import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Loader2, Plug, Plus } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { getProviderIconDataUri } from '@/ui/lib/providers';

interface ProviderConfigItem {
  id: string;
  name: string;
  description: string | null;
  profileId: string;
  providerName?: string;
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

/** Provider icon (falls back to a plug glyph) + config name — the body of every config row. */
function ConfigRowContent({ config }: { config: ProviderConfigItem }) {
  const icon = getProviderIconDataUri(config.providerName);
  return (
    <>
      {icon ? (
        <img
          src={icon}
          alt=""
          aria-hidden="true"
          title={config.providerName ? `Provider: ${config.providerName}` : undefined}
          className="mr-2 h-4 w-4 shrink-0"
        />
      ) : (
        <Plug className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="truncate">{config.name}</span>
    </>
  );
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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Add agent</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent className="w-56" align="start">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : hasNoConfigs ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No provider configs available. Create one in Profiles first.
          </p>
        ) : groupedConfigs.length === 1 ? (
          /* Single profile: no submenu hop — a label plus its configs cannot mix. */
          <>
            <DropdownMenuLabel>{groupedConfigs[0].profileName}</DropdownMenuLabel>
            {groupedConfigs[0].configs.map((config) => (
              <DropdownMenuItem
                key={config.id}
                onSelect={() => handleSelectConfig(config, groupedConfigs[0].profileName)}
              >
                <ConfigRowContent config={config} />
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          /* Two-level menu: profiles at the top level, each opening its provider
             configs in a submenu — configs never sit flat next to profile names. */
          groupedConfigs.map((group) => (
            <DropdownMenuSub key={group.profileId}>
              <DropdownMenuSubTrigger>{group.profileName}</DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="w-52">
                  {group.configs.map((config) => (
                    <DropdownMenuItem
                      key={config.id}
                      onSelect={() => handleSelectConfig(config, group.profileName)}
                    >
                      <ConfigRowContent config={config} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
