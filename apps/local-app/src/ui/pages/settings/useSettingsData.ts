import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import type { FetchFn } from '@/ui/lib/api-transport';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface SettingsResponse {
  claudeBinaryPath?: string;
  codexBinaryPath?: string;
  dbPath?: string;
  initialSessionPromptId?: string | null;
  initialSessionPromptIds?: Record<string, string | null>;
  events?: {
    epicAssigned?: {
      template?: string | null;
    };
  };
  activity?: {
    idleTimeoutMs?: number;
  };
  terminal?: {
    scrollbackLines?: number;
    seedingMaxBytes?: number;
    inputMode?: 'form' | 'tty';
    suppressCtrlCWithSelection?: boolean;
  };
  messagePool?: {
    enabled?: boolean;
    delayMs?: number;
    maxWaitMs?: number;
    maxMessages?: number;
    separator?: string;
  };
  messaging?: {
    followNote?: boolean;
  };
  skills?: {
    syncOnStartup?: boolean;
  };
}

// ────────────────────────────────────────────
// API helpers
// ────────────────────────────────────────────

async function fetchSettings(fetchFn: FetchFn): Promise<SettingsResponse> {
  const res = await fetchFn('/api/settings');
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

async function updateSettingsRequest(
  fetchFn: FetchFn,
  data: Partial<SettingsResponse> & { projectId?: string },
): Promise<SettingsResponse> {
  const res = await fetchFn('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update settings');
  return res.json();
}

// ────────────────────────────────────────────
// Shared toast helpers
// ────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to update settings';
}

// ────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────

export function useSettingsData() {
  const fetchFn = useFetchFactory();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateSettings = () => queryClient.invalidateQueries({ queryKey: ['settings'] });

  const onError = (error: unknown) => {
    toast({ title: 'Update failed', description: errorMessage(error), variant: 'destructive' });
  };

  // ── Query ──────────────────────────────────

  const {
    data: settings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchSettings(fetchFn),
    staleTime: 60_000,
  });

  // ── Mutations ──────────────────────────────

  const updateInitialPromptMutation = useMutation({
    mutationFn: ({
      initialSessionPromptId,
      projectId,
    }: {
      initialSessionPromptId: string | null;
      projectId?: string;
    }) => updateSettingsRequest(fetchFn, { initialSessionPromptId, projectId }),
    onSuccess: () => {
      invalidateSettings();
      toast({
        title: 'Initial session prompt updated',
        description: 'New sessions will start with the selected prompt.',
      });
    },
    onError,
  });

  const updateTerminalMutation = useMutation({
    mutationFn: ({
      scrollbackLines,
      seedingMaxBytes,
      inputMode,
      suppressCtrlCWithSelection,
    }: {
      scrollbackLines: number;
      seedingMaxBytes: number;
      inputMode?: 'form' | 'tty';
      suppressCtrlCWithSelection: boolean;
    }) =>
      updateSettingsRequest(fetchFn, {
        terminal: { scrollbackLines, seedingMaxBytes, inputMode, suppressCtrlCWithSelection },
      }),
    onSuccess: () => {
      invalidateSettings();
      toast({ title: 'Terminal settings updated' });
    },
    onError,
  });

  const updateIdleTimeoutMutation = useMutation({
    mutationFn: ({ idleTimeoutMs }: { idleTimeoutMs: number }) =>
      updateSettingsRequest(fetchFn, { activity: { idleTimeoutMs } }),
    onSuccess: () => {
      invalidateSettings();
      toast({ title: 'Activity idle timeout updated' });
    },
    onError,
  });

  const updateMessagePoolMutation = useMutation({
    mutationFn: ({
      enabled,
      delayMs,
      maxWaitMs,
      maxMessages,
      separator,
    }: {
      enabled: boolean;
      delayMs: number;
      maxWaitMs: number;
      maxMessages: number;
      separator: string;
    }) =>
      updateSettingsRequest(fetchFn, {
        messagePool: { enabled, delayMs, maxWaitMs, maxMessages, separator },
      }),
    onSuccess: () => {
      invalidateSettings();
      toast({ title: 'Message pool settings updated' });
    },
    onError,
  });

  const updateMessagingMutation = useMutation({
    mutationFn: ({ followNote }: { followNote: boolean }) =>
      updateSettingsRequest(fetchFn, { messaging: { followNote } }),
    onSuccess: () => {
      invalidateSettings();
      toast({ title: 'Message delivery settings updated' });
    },
    onError,
  });

  const updateSkillsMutation = useMutation({
    mutationFn: ({ syncOnStartup }: { syncOnStartup: boolean }) =>
      updateSettingsRequest(fetchFn, { skills: { syncOnStartup } }),
    onSuccess: () => {
      invalidateSettings();
      toast({ title: 'Skills settings updated' });
    },
    onError,
  });

  const updateEpicTemplateMutation = useMutation({
    mutationFn: ({ template }: { template: string }) =>
      updateSettingsRequest(fetchFn, { events: { epicAssigned: { template } } }),
    onSuccess: () => {
      invalidateSettings();
      toast({
        title: 'Epic assignment message updated',
        description: 'Agents will see the new message on the next assignment.',
      });
    },
    onError,
  });

  return {
    // Query
    settings,
    isLoading,
    error,

    // Mutations
    updateInitialPromptMutation,
    updateTerminalMutation,
    updateIdleTimeoutMutation,
    updateMessagePoolMutation,
    updateMessagingMutation,
    updateSkillsMutation,
    updateEpicTemplateMutation,
  };
}
