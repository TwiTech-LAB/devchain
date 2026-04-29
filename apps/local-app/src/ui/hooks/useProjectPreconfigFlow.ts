import { useState, useCallback, useRef } from 'react';
import type {
  ParsedTemplateTeam,
  ParsedTemplateProfile,
  TeamOverrideOutput,
} from '@/ui/components/project/ProjectTeamPreconfigDialog';
import { filterConfigurableTeams } from '@/ui/lib/teams';
import type { CreateFromTemplatePayload } from './useTemplateForm';

interface MutateFn {
  mutate: (payload: CreateFromTemplatePayload) => void;
}

export function useProjectPreconfigFlow(mutation: MutateFn) {
  const [preconfigOpen, setPreconfigOpen] = useState(false);
  const [preconfigTeams, setPreconfigTeams] = useState<ParsedTemplateTeam[]>([]);
  const [preconfigProfiles, setPreconfigProfiles] = useState<ParsedTemplateProfile[]>([]);
  const pendingPayloadRef = useRef<CreateFromTemplatePayload | null>(null);

  const handleCreateWithPreconfig = useCallback(
    async (payload: CreateFromTemplatePayload) => {
      try {
        const previewBody: Record<string, unknown> = {};
        if (payload.templatePath) {
          previewBody.templatePath = payload.templatePath;
        } else if (payload.templateId) {
          previewBody.slug = payload.templateId;
          if (payload.version) previewBody.version = payload.version;
        }

        const res = await fetch('/api/templates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(previewBody),
        });

        if (res.ok) {
          const parsed = await res.json();
          const teams: ParsedTemplateTeam[] = parsed.teams ?? [];
          if (filterConfigurableTeams(teams).length > 0) {
            pendingPayloadRef.current = payload;
            setPreconfigTeams(teams);
            setPreconfigProfiles(parsed.profiles ?? []);
            setPreconfigOpen(true);
            return;
          }
        }
      } catch {
        // Preview failed — proceed directly
      }

      mutation.mutate(payload);
    },
    [mutation],
  );

  const handlePreconfigConfirm = useCallback(
    (overrides: TeamOverrideOutput[]) => {
      setPreconfigOpen(false);
      const payload = pendingPayloadRef.current;
      if (!payload) return;
      pendingPayloadRef.current = null;
      mutation.mutate({
        ...payload,
        teamOverrides: overrides,
      });
    },
    [mutation],
  );

  const handlePreconfigCancel = useCallback(() => {
    setPreconfigOpen(false);
    pendingPayloadRef.current = null;
  }, []);

  return {
    preconfigOpen,
    preconfigTeams,
    preconfigProfiles,
    handleCreateWithPreconfig,
    handlePreconfigConfirm,
    handlePreconfigCancel,
  };
}
